/**
 * Claude Review 调用封装（便于单元测试 mock）。
 * 仅供 reviewer.ts 使用。
 *
 * 从 reviewer.ts 抽出，保留原有逻辑：
 *   1. 读 capability systemPrompt
 *   2. 调 GitLab 拉取 MR diff
 *   3. 拼 prompt 调 claude CLI
 *   4. 解析输出判定 label
 */
import axios from 'axios'
import { mask } from '../masking/sensitive-info.js'
import { getCapabilityByKey } from '../../db/repositories/capabilities.js'
import { runClaudeCli } from '../claude-cli.js'
import { isClaudeMock, popMockResponseValidated } from '../mocks/e2e-store.js'

export interface RunClaudeReviewInput {
  projectPath: string
  mrIid: number
  signal?: AbortSignal
}

export interface ClaudeReviewResult {
  label: 'ai-approved' | 'ai-needs-attention'
  summary: string
}

async function fetchMrDiff(projectPath: string, mrIid: number): Promise<string> {
  const gitlabUrl = process.env.GITLAB_URL
  const gitlabToken = process.env.GITLAB_TOKEN
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

  const { projectPath, mrIid, signal } = input

  const capabilityRow = await getCapabilityByKey('ai_review_mr')
  if (!capabilityRow?.systemPrompt) {
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

  const prompt = `${capabilityRow.systemPrompt}\n\nMR !${mrIid}（项目 ${projectPath}）的 diff：\n\n${diffText}`

  const rawOutput = await runClaudeCli({
    prompt,
    allowedTools: 'Read,Glob,Grep',
    timeoutMs: 5 * 60_000,
    onEvent: (e) => console.log(`[ReviewAgent] ${e.type}: ${e.message}`),
    signal,
  })

  const summary = mask(rawOutput)
  const approved =
    summary.includes('ai-approved') || summary.includes('可以合并') || summary.includes('无高风险')
  const label: ClaudeReviewResult['label'] = approved ? 'ai-approved' : 'ai-needs-attention'

  return { label, summary }
}
