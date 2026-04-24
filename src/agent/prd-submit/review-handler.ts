/**
 * prd_ai_review_mr — pipeline stage 2（M3 真实现）。
 *
 * 流程（PRD §3.3）：
 *   1. 从 prd_create_mr 事件读 mrIid / baseTitle（上游传下来的跨 stage 数据）
 *   2. GitLab API 拉 MR diff
 *   3. 读 capability.systemPrompt（管理员后台可覆盖）
 *   4. 调 runClaudePrdReview（JSON 解析 + 启发式 fallback）
 *   5. 回写 MR 评论（复用 gitlabPostMrNote）
 *   6. 关键闸门切换：
 *      - decision === 'pass' → PUT title 去掉 `Draft:` 前缀 → Merge 解锁
 *      - blocked / parseFailed → 保持 Draft（不动）
 *   7. 落事件 { decision, findings, parseFailed?, draftCleared }
 *
 * 容错：un-draft PUT 失败时**不抛异常让 stage failed**（review 本身成功）；
 *      而是落 draftCleared=false，让 notify stage 在 DM 里告知用户。
 */
import axios from 'axios'
import type { TriggerOptions, TriggerResult } from '../coordinator.js'
import { registerCapabilityHandler } from '../coordinator.js'
import { createEvent, findLatest } from '../../db/repositories/prd-submit-events.js'
import { getCapabilityByKey } from '../../db/repositories/capabilities.js'
import { gitlabPostMrNote } from '../review/gitlab-mr-note.js'
import { resolveGitlabConfig } from '../../config/gitlab.js'
import { runClaudePrdReview, type PrdReviewResult } from './claude-prd-review.js'
import { setMrDraft } from './mr-api.js'
import { extractErrorMessage } from './errors.js'

interface Params {
  submissionId: string
  projectPath: string
}

function readParams(opts: TriggerOptions): Params | { error: string } {
  const p = opts.extraParams ?? {}
  if (!p.submissionId || typeof p.submissionId !== 'string') {
    return { error: '缺少 capabilityParams.submissionId' }
  }
  if (!p.projectPath || typeof p.projectPath !== 'string') {
    return { error: '缺少 capabilityParams.projectPath' }
  }
  return { submissionId: p.submissionId, projectPath: p.projectPath }
}

async function fetchMrDiff(projectPath: string, mrIid: number): Promise<string> {
  const { url, token } = await resolveGitlabConfig()
  if (!url || !token) throw new Error('缺少 GitLab url 或 token 配置')
  const resp = await axios.get(
    `${url}/api/v4/projects/${encodeURIComponent(projectPath)}/merge_requests/${mrIid}/changes`,
    { headers: { 'PRIVATE-TOKEN': token }, timeout: 30_000 },
  )
  const changes = (resp.data?.changes ?? []) as Array<{
    old_path?: string
    new_path?: string
    diff?: string
  }>
  return changes
    .map(c => `--- ${c.old_path ?? ''}\n+++ ${c.new_path ?? ''}\n${c.diff ?? ''}`)
    .join('\n\n')
}

function buildReviewNoteBody(review: PrdReviewResult): string {
  const header = review.decision === 'pass'
    ? '## 🤖 AI Review 结论：✅ pass\n\n**Merge 闸门已解除**（Draft 前缀已移除）\n'
    : '## 🤖 AI Review 结论：⚠️ blocked\n\n**MR 保持 Draft，Merge 按钮禁用**。请根据下面意见修复后 push 新 commit，再次 @agent 触发新一轮 review。\n'

  const lines = [header]

  if (review.parseFailed) {
    lines.push('> ⚠️ Claude 输出未能解析为结构化 JSON，启发式降级处理。下面内容来自原始输出。\n')
  }

  if (review.findings.length > 0) {
    lines.push('### Findings')
    for (const f of review.findings) {
      const sev = f.severity === 'blocker' ? '🛑 **blocker**'
        : f.severity === 'warning' ? '⚠️ warning'
        : 'ℹ️ info'
      lines.push(`- ${sev} — **${f.title}**${f.detail ? `\n  ${f.detail}` : ''}`)
    }
    lines.push('')
  }

  lines.push('---', '', review.markdown)
  return lines.join('\n')
}

export async function handlePrdAiReviewMr(opts: TriggerOptions): Promise<TriggerResult> {
  const parsed = readParams(opts)
  if ('error' in parsed) {
    return { success: false, error: parsed.error }
  }
  const { submissionId, projectPath } = parsed

  // 1. 读上游 prd_create_mr 事件，拿 mrIid + baseTitle（stage 1 强制 Draft 用到）
  const createMrEvent = await findLatest(submissionId, 'prd_create_mr')
  if (!createMrEvent || createMrEvent.status !== 'success') {
    await createEvent({
      submissionId, projectPath,
      code: 'prd_ai_review_mr', status: 'failed',
      data: { error: 'stage 1 prd_create_mr 未成功，跳过 review' },
    })
    return { success: false, error: 'prd_create_mr not successful' }
  }

  const createData = createMrEvent.data as Record<string, unknown>
  const mrIid = createData.mrIid as number | undefined
  const baseTitle = createData.baseTitle as string | undefined

  if (!mrIid || !baseTitle) {
    await createEvent({
      submissionId, projectPath,
      code: 'prd_ai_review_mr', status: 'failed',
      data: { error: 'prd_create_mr 事件 data.mrIid 或 data.baseTitle 缺失' },
    })
    return { success: false, error: 'missing mrIid or baseTitle in prd_create_mr event' }
  }

  // 2. 读 system_prompt（管理员后台可覆盖，优先 system_prompt 再 defaultSystemPrompt）
  const capability = await getCapabilityByKey('prd_ai_review_mr')
  const systemPrompt = capability?.systemPrompt ?? capability?.defaultSystemPrompt
  if (!systemPrompt) {
    await createEvent({
      submissionId, projectPath,
      code: 'prd_ai_review_mr', status: 'failed',
      data: { error: 'prd_ai_review_mr 未配置 system_prompt，检查 migrate 是否跑过' },
    })
    return { success: false, error: 'prd_ai_review_mr.system_prompt missing' }
  }

  // 3. 拉 MR diff
  let mrDiff: string
  try {
    mrDiff = await fetchMrDiff(projectPath, mrIid)
  } catch (err) {
    const msg = extractErrorMessage(err)
    await createEvent({
      submissionId, projectPath,
      code: 'prd_ai_review_mr', status: 'failed',
      data: { error: `fetch MR diff 失败: ${msg}`, mrIid },
    })
    return { success: false, error: msg }
  }

  if (!mrDiff.trim()) {
    // 没有 diff（理论上 MR 创建成功就会有；这里是防御）
    await createEvent({
      submissionId, projectPath,
      code: 'prd_ai_review_mr', status: 'failed',
      data: { error: 'MR diff 为空', mrIid },
    })
    return { success: false, error: 'empty MR diff' }
  }

  // 4. 调 Claude
  let review: PrdReviewResult
  try {
    review = await runClaudePrdReview({
      mrDiff,
      systemPrompt,
      signal: opts.signal,
    })
  } catch (err) {
    const msg = extractErrorMessage(err)
    console.error(`[prd_ai_review_mr] Claude runner 失败:`, msg)
    await createEvent({
      submissionId, projectPath,
      code: 'prd_ai_review_mr', status: 'failed',
      data: { error: `Claude runner 失败: ${msg}`, mrIid },
    })
    return { success: false, error: msg }
  }

  // 5. 回写 MR 评论
  try {
    await gitlabPostMrNote({
      projectPath,
      mrIid,
      body: buildReviewNoteBody(review),
    })
  } catch (err) {
    // POST note 失败不致命；review 本身已完成，记日志但继续尝试 un-draft
    console.error(`[prd_ai_review_mr] POST note 失败:`, extractErrorMessage(err))
  }

  // 6. Draft 闸门切换：pass 才 un-draft
  let draftCleared = false
  let draftClearError: string | null = null
  if (review.decision === 'pass') {
    try {
      await setMrDraft(projectPath, mrIid, baseTitle, false)
      draftCleared = true
      console.log(`[prd_ai_review_mr] MR !${mrIid} 已解除 Draft（可合并）`)
    } catch (err) {
      draftClearError = extractErrorMessage(err)
      console.error(`[prd_ai_review_mr] un-draft PUT 失败（review 仍视为成功）:`, draftClearError)
      // 不抛错；notify stage 的 DM 会告知用户"review 通过但解除 Draft 失败"
    }
  }

  // 7. 落事件
  await createEvent({
    submissionId, projectPath,
    code: 'prd_ai_review_mr', status: 'success',
    data: {
      mrIid,
      decision: review.decision,
      findings: review.findings,
      parseFailed: review.parseFailed ?? false,
      draftCleared,
      ...(draftClearError ? { draftClearError } : {}),
    },
  })

  return {
    success: true,
    output: `Review 完成 (decision=${review.decision}, findings=${review.findings.length}${review.parseFailed ? ', parseFailed' : ''}${draftCleared ? ', draft cleared' : ''})`,
    data: { mrIid, decision: review.decision, draftCleared },
  }
}

export function registerPrdAiReviewHandler(): void {
  registerCapabilityHandler('prd_ai_review_mr', handlePrdAiReviewMr)
  console.log('[prd_ai_review_mr] handler registered')
}
