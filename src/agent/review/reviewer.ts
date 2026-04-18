/**
 * ai_review_mr capability handler：按 report 循环所有 create_mr 事件进行 Review。
 *
 * 职责：
 *  1. 查所有 create_mr 成功事件，得到待 Review 的 MR 列表
 *  2. 幂等：跳过已有 ai_review 成功事件的 MR
 *  3. 调 Claude 生成 Review 评语与结论 label
 *  4. 将评语作为 Note 写到 GitLab MR
 *  5. 保留原有 label 更新逻辑（ai-approved / ai-needs-attention）
 *  6. 多 project 场景在 Note 开头加跨服务协调提示
 *  7. 每个 MR 完成后写 bug_fix_events(code='ai_review')
 */
import type { TriggerOptions, TriggerResult } from '../coordinator.js'
import { registerCapabilityHandler } from '../coordinator.js'
import {
  createEvent,
  findByReportCode,
  findLatest,
} from '../../db/repositories/bug-fix-events.js'
import { runClaudeReview } from './claude-review.js'
import { gitlabPostMrNote, gitlabUpdateMrLabels } from './gitlab-mr-note.js'

export async function handleReviewMr(opts: TriggerOptions): Promise<TriggerResult> {
  const reportId = Number(opts.extraParams?.reportId)
  if (!reportId) {
    return { success: false, error: 'missing_reportId', output: '参数错误: 缺少 reportId' }
  }

  const createMrEvents = await findByReportCode(reportId, 'create_mr')
  const successMrs = createMrEvents.filter(e => e.status === 'success' && e.projectPath)
  if (successMrs.length === 0) {
    return { success: false, error: 'no_mrs', output: '无可 Review 的 MR（report 下没有 create_mr success 事件）' }
  }

  const multiProject = successMrs.length > 1
  const failures: string[] = []
  const reviewed: Array<{ projectPath: string; mrIid: number; label: string; skipped: boolean }> = []

  for (const mrEvent of successMrs) {
    const projectPath = mrEvent.projectPath as string
    const mrIid = (mrEvent.data as Record<string, unknown>).mrIid as number

    // 幂等检查：若已有 ai_review 成功事件则跳过
    const existing = await findLatest(reportId, projectPath, 'ai_review')
    if (existing && existing.status === 'success') {
      const existingLabel = ((existing.data as Record<string, unknown>).label as string) ?? 'unknown'
      reviewed.push({ projectPath, mrIid, label: existingLabel, skipped: true })
      continue
    }

    try {
      const review = await runClaudeReview({ projectPath, mrIid, signal: opts.signal })

      const body = buildReviewNoteBody({
        label: review.label,
        summary: review.summary,
        multiProject,
        totalMrs: successMrs.length,
      })

      await gitlabPostMrNote({ projectPath, mrIid, body })

      await gitlabUpdateMrLabels({
        projectPath,
        mrIid,
        labelToAdd: review.label,
      }).catch(err =>
        console.error(`[ReviewAgent] MR !${mrIid} label 更新失败:`, err instanceof Error ? err.message : String(err)),
      )

      await createEvent({
        reportId,
        projectPath,
        code: 'ai_review',
        status: 'success',
        data: { label: review.label, mrIid, reviewSummary: review.summary },
      })
      reviewed.push({ projectPath, mrIid, label: review.label, skipped: false })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[ReviewAgent] MR ${projectPath}#${mrIid} review 失败:`, msg)
      await createEvent({
        reportId,
        projectPath,
        code: 'ai_review',
        status: 'failed',
        data: { mrIid, error: msg },
      })
      failures.push(`${projectPath}#${mrIid}: ${msg}`)
    }
  }

  if (failures.length > 0) {
    return {
      success: false,
      error: 'review_failed',
      output: `部分 MR Review 失败: ${failures.join('; ')}`,
    }
  }

  const summary = reviewed
    .map(r => `${r.projectPath}#${r.mrIid}(${r.label}${r.skipped ? ',已存在' : ''})`)
    .join(', ')
  return {
    success: true,
    output: `完成 Review ${reviewed.length} 个 MR: ${summary}`,
  }
}

function buildReviewNoteBody(p: {
  label: string
  summary: string
  multiProject: boolean
  totalMrs: number
}): string {
  const lines: string[] = []
  if (p.multiProject) {
    lines.push(`⚠️ 此为跨服务修复的一部分，请确保所有 ${p.totalMrs} 个 MR 都通过 Review 后再协调合并。`)
    lines.push('')
  }
  lines.push('## 🤖 AI Review 结果')
  lines.push('')
  lines.push(`**结论：** ${p.label}`)
  lines.push('')
  lines.push(p.summary)
  return lines.join('\n')
}

export function registerReviewHandler(): void {
  registerCapabilityHandler('ai_review_mr', handleReviewMr)
  console.log('[ReviewAgent] ai_review_mr handler registered')
}
