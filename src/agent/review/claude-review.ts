/**
 * Claude Review 调用封装（便于单元测试 mock）。
 * 仅供 reviewer.ts 使用。
 *
 * 执行逻辑：
 *   1. 读 capability systemPrompt
 *   2. 调 GitLab 拉取 MR diff
 *   3. acquire worktree（fix 分支）——让 Claude 能 Grep/Read 完整代码库，不只看 diff
 *   4. 拼 prompt，executor.run(cwd=worktree.path)
 *   5. 解析输出判定 label，finally release worktree
 */
import axios from 'axios'
import { mask } from '../masking/sensitive-info.js'
import { getCapabilityByKey } from '../../db/repositories/capabilities.js'
import { getClaudeExecutor } from '../claude-executor.js'
import { acquire, release, makeWorktreeKey } from '../worktree/manager.js'
import { projectPathToGitUrl } from '../fix/fix-logic.js'
import { resolveGitlabConfig } from '../../config/gitlab.js'
import { isClaudeMock, popMockResponseValidated } from '../mocks/e2e-store.js'

export interface RunClaudeReviewInput {
  projectPath: string
  mrIid: number
  /** 产品线 id，用于 worktree acquire 的 product 命名 */
  productLineId: number
  /** fix 分支名（create_mr 事件 data.branch），worktree checkout 到此分支让 Claude 看到修改后代码 */
  fixBranch: string
  signal?: AbortSignal
}

export interface ClaudeReviewResult {
  label: 'ai-approved' | 'ai-needs-attention'
  summary: string
}

async function fetchMrDiff(projectPath: string, mrIid: number): Promise<string> {
  const { url: gitlabUrl, token: gitlabToken } = await resolveGitlabConfig()
  if (!gitlabUrl || !gitlabToken) return ''

  const resp = await axios.get(
    `${gitlabUrl}/api/v4/projects/${encodeURIComponent(projectPath)}/merge_requests/${mrIid}/changes`,
    { headers: { 'PRIVATE-TOKEN': gitlabToken }, timeout: 30_000 },
  )
  const changes = resp.data.changes ?? []
  return changes.map((c: any) => `--- ${c.old_path}\n+++ ${c.new_path}\n${c.diff}`).join('\n\n')
}

export async function runClaudeReview(input: RunClaudeReviewInput): Promise<ClaudeReviewResult> {
  if (isClaudeMock()) {
    return popMockResponseValidated<ClaudeReviewResult>(
      `review-${input.mrIid}`,
      ['label', 'summary'],
    )
  }

  const { projectPath, mrIid, productLineId, fixBranch, signal } = input

  const capabilityRow = await getCapabilityByKey('ai_review_mr')
  const effectivePrompt = capabilityRow?.systemPrompt ?? capabilityRow?.defaultSystemPrompt ?? null
  if (!effectivePrompt) {
    throw new Error('ai_review_mr 未配置 systemPrompt，请在管理后台配置')
  }

  let diffText = ''
  try {
    diffText = await fetchMrDiff(projectPath, mrIid)
  } catch (err) {
    console.error(`[ReviewAgent] 获取 MR diff 失败:`, err instanceof Error ? err.message : String(err))
  }

  if (!diffText) {
    throw new Error('无法获取 MR diff')
  }

  // acquire fix 分支 worktree，让 Claude 能 Grep/Read 完整代码库（不只看 diff）
  const key = makeWorktreeKey({ productLineId, projectPath, branch: fixBranch })
  const worktree = await acquire({
    userId: 'review-agent',
    product: `pl-${productLineId}`,
    version: fixBranch,
    sessionId: `review-${projectPath.replace(/\//g, '-')}-${mrIid}-${key}`,
    repoUrl: await projectPathToGitUrl(projectPath),
    projectPath,
  })

  try {
    const prompt =
      `${effectivePrompt}\n\n` +
      `你的工作目录已切到 **${projectPath}** 仓库的 fix 分支 \`${fixBranch}\`——` +
      `可用 Glob/Grep/Read 查阅**完整源码**（不限于 diff 范围），` +
      `特别推荐用来核查被修改函数的其他调用点、继承/实现方、反射引用。\n\n` +
      `MR !${mrIid}（项目 ${projectPath}）的 diff：\n\n${diffText}`

    const rawOutput = await getClaudeExecutor().run({
      prompt,
      allowedTools: 'Read,Glob,Grep',
      timeoutMs: 10 * 60_000,
      onEvent: (e) => console.log(`[ReviewAgent] ${e.type}: ${e.message}`),
      signal,
      cwd: worktree.path,
    })

    const summary = mask(rawOutput)
    const approved =
      summary.includes('ai-approved') || summary.includes('可以合并') || summary.includes('无高风险')
    const label: ClaudeReviewResult['label'] = approved ? 'ai-approved' : 'ai-needs-attention'

    return { label, summary }
  } finally {
    release(worktree)
  }
}
