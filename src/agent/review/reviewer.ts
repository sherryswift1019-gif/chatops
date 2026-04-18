import { registerCapabilityHandler } from '../coordinator.js'
import { mask } from '../masking/sensitive-info.js'
import { updateMrLabels } from '../../adapters/gitlab/labels.js'
import { getCapabilityByKey } from '../../db/repositories/capabilities.js'
import { runClaudeCli } from '../claude-cli.js'
import axios from 'axios'
import type { TriggerOptions, TriggerResult } from '../coordinator.js'

async function handleReviewMr(opts: TriggerOptions): Promise<TriggerResult> {
  const mrIid = opts.extraParams?.mrIid as number | undefined
  const projectPath = opts.extraParams?.projectPath as string | undefined

  if (!mrIid || !projectPath) {
    return { success: false, error: '缺少 mrIid 或 projectPath' }
  }

  console.log(`[ReviewAgent] reviewing MR !${mrIid} in ${projectPath}`)

  const capabilityRow = await getCapabilityByKey('ai_review_mr')
  if (!capabilityRow?.systemPrompt) {
    return { success: false, error: 'ai_review_mr 未配置 systemPrompt，请在管理后台配置' }
  }

  // 获取 MR diff
  const gitlabUrl = process.env.GITLAB_URL
  const gitlabToken = process.env.GITLAB_TOKEN
  let diffText = ''
  if (gitlabUrl && gitlabToken) {
    try {
      const resp = await axios.get(
        `${gitlabUrl}/api/v4/projects/${encodeURIComponent(projectPath)}/merge_requests/${mrIid}/changes`,
        { headers: { 'PRIVATE-TOKEN': gitlabToken }, timeout: 30_000 }
      )
      const changes = resp.data.changes ?? []
      diffText = changes.map((c: any) => `--- ${c.old_path}\n+++ ${c.new_path}\n${c.diff}`).join('\n\n')
    } catch (err) {
      console.error(`[ReviewAgent] 获取 MR diff 失败:`, err instanceof Error ? err.message : String(err))
    }
  }

  if (!diffText) {
    return { success: false, error: '无法获取 MR diff' }
  }

  // 直接调 claude CLI 审查
  const prompt = `${capabilityRow.systemPrompt}\n\nMR !${mrIid}（项目 ${projectPath}）的 diff：\n\n${diffText}`

  const rawOutput = await runClaudeCli({
    prompt,
    allowedTools: 'Read,Glob,Grep',
    timeoutMs: 5 * 60_000,
    onEvent: (e) => console.log(`[ReviewAgent] ${e.type}: ${e.message}`),
    signal: opts.signal,
  })

  const output = mask(rawOutput)
  const approved = output.includes('ai-approved') || output.includes('可以合并') || output.includes('无高风险')
  const label = approved ? 'ai-approved' : 'ai-needs-attention'

  // 在 MR 上添加 Review 结论标签
  await updateMrLabels(projectPath, mrIid, { add: [label] }).catch(err =>
    console.error(`[ReviewAgent] MR !${mrIid} label 更新失败:`, err)
  )

  // 通知由 coordinator.handleFixComplete 处理

  return {
    success: true,
    output: `Review 完成（${label}）:\n\n${output}`,
    data: { label, mrIid },
  }
}

export function registerReviewHandler(): void {
  registerCapabilityHandler('ai_review_mr', handleReviewMr)
  console.log('[ReviewAgent] ai_review_mr handler registered')
}
