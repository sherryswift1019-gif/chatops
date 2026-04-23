/**
 * 单 project 修复逻辑（从 fix-runner.ts 抽出，便于单测 mock）。
 *
 * 只负责：clone worktree → 创建 fix 分支 → Claude 修复 → 运行测试 → commit + push。
 * 不写 bug_fix_events、不创建 MR、不发通知（由 fix-runner handler / 独立 capability 负责）。
 */
import { promises as fs } from 'fs'
import { join } from 'path'
import { acquire, release, makeWorktreeKey } from '../worktree/manager.js'
import { getCapabilityByKey } from '../../db/repositories/capabilities.js'
import { createFixBranch, commitChanges, pushBranch, rebaseOnTarget } from './branch-manager.js'
import { getClaudeExecutor } from '../claude-executor.js'
import { gitlabGetIssue } from '../analysis/gitlab-issue.js'
import { mask } from '../masking/sensitive-info.js'
import { isClaudeMock, popMockResponseValidated } from '../mocks/e2e-store.js'
import { resolveGitlabConfig } from '../../config/gitlab.js'

/**
 * 判断 Claude 输出是否表示修复成功。
 *
 * 判定规则：**严格匹配 prompt 约定的 marker** — 输出末尾非空行为 `修复完成`。
 *
 * 为什么不做 fuzzy 关键字匹配（历史版本做过，已废弃）：
 * - Claude 在解释根因 / 引用日志时常出现 "测试失败" / "test failed" 字样，
 *   误触发 failurePatterns → 明明改好了却判失败（2026-04-23 踩坑）
 * - fix_bug_lN prompt 已明确要求："输出末尾单独一行回复 `修复完成`"，marker 是唯一可靠信号
 */
export function isFixSuccessful(output: string): boolean {
  const lines = output.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0)
  if (lines.length === 0) return false
  return lines[lines.length - 1] === '修复完成'
}

/** 根据 projectPath 拼 GitLab 克隆 URL */
export async function projectPathToGitUrl(projectPath: string): Promise<string> {
  const { url } = await resolveGitlabConfig()
  const base = (url ?? '').replace(/\/$/, '')
  return `${base}/${projectPath}.git`
}

/**
 * 预取 GitLab Issue 描述写入 worktree 根目录的 `.issue.md`，供 Claude 通过 Read 读取。
 * 失败向上抛出（不静默），由调用方决定降级策略。
 */
export async function preloadIssueToWorktree(
  worktreePath: string,
  projectPath: string,
  issueIid: number,
): Promise<void> {
  const issue = await gitlabGetIssue(projectPath, issueIid)
  await fs.writeFile(join(worktreePath, '.issue.md'), issue.description, 'utf-8')
}

export interface RunFixForProjectInput {
  reportId: number
  productLineId: number
  projectPath: string
  sourceBranch: string
  affectedModules: string[]
  rootCauseSummary: string | null
  solutionsJson: unknown
  issueId: number
  confidence: string
  level: string
  attempt: number
  signal?: AbortSignal
}

export interface RunFixForProjectResult {
  branch: string
  testPassed: boolean
  output?: string
  error?: string
}

/**
 * 单 project 修复流程：acquire worktree（带 projectPath）→ 创建 fix 分支 → Claude 修复 → 运行测试 → commit + push。
 * 返回 { branch, testPassed, error? }，不写事件、不创建 MR、不发通知。
 */
export async function runFixForProject(input: RunFixForProjectInput): Promise<RunFixForProjectResult> {
  if (isClaudeMock()) {
    return popMockResponseValidated<RunFixForProjectResult>(
      `fix-${input.projectPath}`,
      ['branch', 'testPassed', 'output'],
    )
  }

  const key = makeWorktreeKey({
    productLineId: input.productLineId,
    projectPath: input.projectPath,
    branch: input.sourceBranch,
  })

  const worktree = await acquire({
    userId: 'fix-agent',
    product: `pl-${input.productLineId}`,
    version: input.sourceBranch,
    sessionId: `fix-${input.reportId}-${input.projectPath.replace(/\//g, '-')}-${input.attempt}-${key}`,
    repoUrl: await projectPathToGitUrl(input.projectPath),
    projectPath: input.projectPath,
  })

  try {
    const branch = await createFixBranch(worktree.path, input.issueId, input.attempt)
    console.log(
      `[FixAgent] report=${input.reportId} project=${input.projectPath} attempt=${input.attempt}: branch=${branch}, cwd=${worktree.path}`,
    )

    const capabilityRow = await getCapabilityByKey(`fix_bug_${input.level}`)
    const effectivePrompt = capabilityRow?.systemPrompt ?? capabilityRow?.defaultSystemPrompt ?? null
    if (!effectivePrompt) {
      return { branch, testPassed: false, error: `fix_bug_${input.level} 未配置 systemPrompt` }
    }

    // 预取 Issue 描述到 worktree/.issue.md，供 Claude Read 读取（替代 prompt 里硬拼根因/方案/影响模块）
    try {
      await preloadIssueToWorktree(worktree.path, input.projectPath, input.issueId)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { branch, testPassed: false, error: `预取 Issue #${input.issueId} 失败: ${msg}` }
    }

    const prompt = `${effectivePrompt}

代码仓库路径: ${worktree.path}
项目: ${input.projectPath}
源分支: ${input.sourceBranch}
Issue 详情: \`.issue.md\`（位于代码仓库根目录；含根因分析、推荐方案、影响模块）

修复 Bug（report=${input.reportId}, issue=#${input.issueId}, attempt=${input.attempt}, 等级 ${input.level}）
`

    const rawOutput = await getClaudeExecutor().run({
      prompt,
      allowedTools: 'Read,Glob,Grep,Bash,Write,Edit',
      timeoutMs: 20 * 60_000,
      onEvent: e => console.log(`[FixAgent] ${e.type}: ${e.message}`),
      signal: input.signal,
    })

    const output = mask(rawOutput)

    if (!isFixSuccessful(output)) {
      console.log(
        `[FixAgent] report=${input.reportId} project=${input.projectPath} attempt=${input.attempt}: 修复未成功`,
      )
      return { branch, testPassed: false, output, error: '测试未通过' }
    }

    // commit + rebase + push
    try {
      await commitChanges(worktree.path, {
        level: input.level,
        issueTitle: (input.rootCauseSummary ?? '').substring(0, 60),
        issueId: input.issueId,
        attempt: input.attempt,
        hypothesis: (input.rootCauseSummary ?? '').substring(0, 100),
        changed: '由 AI Agent 自动修复',
        testResult: '通过',
        next: '等待 AI Review',
        confidence: input.confidence,
      })
    } catch (err) {
      // commit 失败常见原因：git 身份未配置、pre-commit hook 失败、workdir 无变更
      // 包 try/catch 保住 branch 字段，方便前端 Attempt 卡片展示 + coordinator 聚合 failureSummary
      const msg = err instanceof Error ? err.message : String(err)
      return { branch, testPassed: false, output, error: `commit 失败: ${msg}` }
    }

    const rebaseResult = await rebaseOnTarget(worktree.path, input.sourceBranch)
    if (!rebaseResult.success) {
      // rebase 失败两类：conflict（冲突需人工解）/ 其他失败（fetch 挂 / 分支不存在 /
      // 网络超时等）。原实现只判 conflict，非冲突失败会 fall through 到 push，导致
      // MR 被开但分支没真 rebase 到 target → 见 TODO §7 / 2026-04-21 踩坑记录
      return {
        branch,
        testPassed: false,
        output,
        error: rebaseResult.conflict
          ? `与 ${input.sourceBranch} 存在冲突，需要人工解决`
          : `rebase 失败（非冲突），查后端日志定位`,
      }
    }

    try {
      await pushBranch(worktree.path, branch)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        branch,
        testPassed: false,
        output,
        error: `push 分支 ${branch} 失败（rebase 已完成但推送未成功）: ${msg}`,
      }
    }

    return { branch, testPassed: true, output }
  } finally {
    release(worktree)
  }
}
