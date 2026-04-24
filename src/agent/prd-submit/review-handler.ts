/**
 * prd_ai_review_mr — pipeline stage 2。
 *
 * ⚠️ M2 版本只做骨架：读 MR iid 后 POST 一条占位评论，落事件 decision='pass'
 * （但**不解除 Draft**，避免 placeholder 的"pass"误放行真实 MR）。
 *
 * M3 替换：接真实 Claude review + JSON 解析 + pass 时调 setMrDraft(..., false)。
 */
import type { TriggerOptions, TriggerResult } from '../coordinator.js'
import { registerCapabilityHandler } from '../coordinator.js'
import { createEvent, findLatest } from '../../db/repositories/prd-submit-events.js'
import { gitlabPostMrNote } from '../review/gitlab-mr-note.js'

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
  return {
    submissionId: p.submissionId,
    projectPath: p.projectPath,
  }
}

export async function handlePrdAiReviewMr(opts: TriggerOptions): Promise<TriggerResult> {
  const parsed = readParams(opts)
  if ('error' in parsed) {
    return { success: false, error: parsed.error }
  }
  const { submissionId, projectPath } = parsed

  try {
    const createMrEvent = await findLatest(submissionId, 'prd_create_mr')
    if (!createMrEvent || createMrEvent.status !== 'success') {
      // stage 1 失败（onFailure=continue 让我们跑到这里），跳过 review，标记失败
      await createEvent({
        submissionId, projectPath,
        code: 'prd_ai_review_mr', status: 'failed',
        data: { error: 'stage 1 prd_create_mr 未成功，跳过 review' },
      })
      return { success: false, error: 'prd_create_mr not successful' }
    }

    const mrIid = (createMrEvent.data as Record<string, unknown>).mrIid as number
    if (!mrIid) {
      await createEvent({
        submissionId, projectPath,
        code: 'prd_ai_review_mr', status: 'failed',
        data: { error: 'prd_create_mr 事件 data.mrIid 缺失' },
      })
      return { success: false, error: 'missing mrIid in prd_create_mr event' }
    }

    // M2 占位：POST 一条"施工中"评论
    const placeholderBody =
      '## 🤖 AI Review (M2 Placeholder)\n\n' +
      'AI review 内核尚未接入（M3 任务），此为占位评论。\n' +
      'M3 会替换为真实 Claude review + 结构化 findings + Draft 闸门切换。'
    await gitlabPostMrNote({ projectPath, mrIid, body: placeholderBody })

    await createEvent({
      submissionId, projectPath,
      code: 'prd_ai_review_mr', status: 'success',
      data: {
        decision: 'pass',
        findings: [],
        parseFailed: false,
        draftCleared: false, // M2 placeholder 不解除 Draft（M3 才做）
        placeholder: true,
      },
    })
    return {
      success: true,
      output: `M2 placeholder: 已在 MR !${mrIid} POST 占位评论（MR 保持 Draft）`,
      data: { mrIid, decision: 'pass', placeholder: true },
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[prd_ai_review_mr] placeholder 失败:`, msg)
    await createEvent({
      submissionId, projectPath,
      code: 'prd_ai_review_mr', status: 'failed',
      data: { error: msg },
    })
    return { success: false, error: msg }
  }
}

export function registerPrdAiReviewHandler(): void {
  registerCapabilityHandler('prd_ai_review_mr', handlePrdAiReviewMr)
  console.log('[prd_ai_review_mr] handler registered (M2 placeholder)')
}
