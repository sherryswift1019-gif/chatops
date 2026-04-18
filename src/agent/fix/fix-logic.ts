/**
 * 单 project 修复逻辑（从 fix-runner.ts 抽出，便于单测 mock）。
 *
 * 只负责：clone worktree → 创建 fix 分支 → Claude 修复 → 运行测试 → commit + push。
 * 不写 bug_fix_events、不创建 MR、不发通知（由 fix-runner handler / 独立 capability 负责）。
 */
import { acquire, release, makeWorktreeKey } from '../worktree/manager.js'
import { getCapabilityByKey } from '../../db/repositories/capabilities.js'
import { createFixBranch, commitChanges, pushBranch, rebaseOnTarget } from './branch-manager.js'
import { runClaudeCli } from '../claude-cli.js'
import { mask } from '../masking/sensitive-info.js'
import { isClaudeMock, popMockResponse } from '../mocks/e2e-store.js'

/** 判断 Claude 输出是否表示修复成功（保留导出以兼容旧集成测试） */
export function isFixSuccessful(output: string): boolean {
  const successPatterns = ['所有测试通过', '测试通过', 'tests passed', 'all tests pass', 'BUILD SUCCESS']
  const failurePatterns = ['测试失败', '编译失败', 'test failed', 'BUILD FAILURE', 'COMPILATION ERROR']

  const hasSuccess = successPatterns.some(p => output.toLowerCase().includes(p.toLowerCase()))
  const hasFailure = failurePatterns.some(p => output.toLowerCase().includes(p.toLowerCase()))

  if (hasSuccess && hasFailure) {
    const lastSuccessIdx = Math.max(...successPatterns.map(p => output.toLowerCase().lastIndexOf(p.toLowerCase())))
    const lastFailureIdx = Math.max(...failurePatterns.map(p => output.toLowerCase().lastIndexOf(p.toLowerCase())))
    return lastSuccessIdx > lastFailureIdx
  }

  return hasSuccess
}

/** 根据 projectPath 拼 GitLab 克隆 URL */
export function projectPathToGitUrl(projectPath: string): string {
  const base = (process.env.GITLAB_URL ?? '').replace(/\/$/, '')
  return `${base}/${projectPath}.git`
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
    const key = `fix-${input.projectPath}`
    const mock = popMockResponse(key)
    if (mock === undefined) throw new Error(`E2E: no mock response queued for ${key}`)
    return mock as RunFixForProjectResult
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
    repoUrl: projectPathToGitUrl(input.projectPath),
    projectPath: input.projectPath,
  })

  try {
    const branch = await createFixBranch(worktree.path, input.issueId, input.attempt)
    console.log(
      `[FixAgent] report=${input.reportId} project=${input.projectPath} attempt=${input.attempt}: branch=${branch}, cwd=${worktree.path}`,
    )

    const capabilityRow = await getCapabilityByKey(`fix_bug_${input.level}`)
    if (!capabilityRow?.systemPrompt) {
      return { branch, testPassed: false, error: `fix_bug_${input.level} 未配置 systemPrompt` }
    }

    const solutionsSummary = Array.isArray(input.solutionsJson)
      ? (input.solutionsJson as Array<Record<string, unknown>>)
          .map(
            s =>
              `- [${s.recommended ? '推荐' : '备选'}] ${s.summary}（风险:${s.risk}, 工作量:${s.effort}）`,
          )
          .join('\n')
      : '无方案'

    const prompt = `${capabilityRow.systemPrompt}

代码仓库路径: ${worktree.path}
项目: ${input.projectPath}
源分支: ${input.sourceBranch}

修复 Bug（report=${input.reportId}, issue=#${input.issueId}, attempt=${input.attempt}, 等级 ${input.level}）

## 根因分析
${input.rootCauseSummary ?? '(未提供)'}

## 修复方案
${solutionsSummary}

## 影响模块
${input.affectedModules.join(', ') || '未知'}

请按照推荐方案修复代码。修复后用 Bash 工具运行测试验证。
修复成功请回复"所有测试通过"，失败请说明原因。`

    const rawOutput = await runClaudeCli({
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

    const rebaseResult = await rebaseOnTarget(worktree.path, input.sourceBranch)
    if (rebaseResult.conflict) {
      return { branch, testPassed: false, output, error: `与 ${input.sourceBranch} 存在冲突，需要人工解决` }
    }

    await pushBranch(worktree.path, branch)

    return { branch, testPassed: true, output }
  } finally {
    release(worktree)
  }
}
