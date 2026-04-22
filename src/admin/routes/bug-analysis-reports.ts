import type { FastifyInstance } from 'fastify'
import {
  getBugAnalysisReportById,
  listReportsByProductLinePaged,
  updateReportStatus,
  type BugLevel,
  type ReportStatus,
} from '../../db/repositories/bug-analysis-reports.js'
import { createEvent, findByReport } from '../../db/repositories/bug-fix-events.js'
import { handleAnalyzeBug } from '../../agent/analysis/analyzer.js'
import { handleAnalysisComplete, checkAndTriggerHandover } from '../../agent/coordinator.js'

const VALID_STATUSES: ReportStatus[] = [
  'draft',
  'published',
  'pipeline_success',
  'pending_manual',
  'completed',
  'aborted',
]
const VALID_LEVELS: BugLevel[] = ['l1', 'l2', 'l3', 'l4']

function parseCsvEnum<T extends string>(
  raw: unknown,
  allowed: readonly T[],
): T[] | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined
  const text = String(raw)
  const parts = text
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0)
  const filtered = parts.filter((p): p is T => (allowed as readonly string[]).includes(p))
  return filtered.length > 0 ? filtered : undefined
}

export async function registerBugAnalysisReportRoutes(app: FastifyInstance): Promise<void> {
  app.get('/bug-analysis-reports', async (req) => {
    const query = req.query as Record<string, unknown>
    const rawProductLineId = query.product_line_id != null && query.product_line_id !== ''
      ? Number(query.product_line_id)
      : NaN
    const productLineId = Number.isFinite(rawProductLineId) && rawProductLineId > 0
      ? rawProductLineId
      : undefined
    const rawIssueId = query.issueId != null && query.issueId !== ''
      ? Number(query.issueId)
      : NaN
    const issueId = Number.isFinite(rawIssueId) && rawIssueId > 0 ? rawIssueId : undefined

    const rawKeyword = typeof query.keyword === 'string' ? query.keyword.trim() : ''
    const keyword = rawKeyword.length > 0 ? rawKeyword.slice(0, 200) : undefined

    const statuses = parseCsvEnum(query.status, VALID_STATUSES)
    const levels = parseCsvEnum(query.level, VALID_LEVELS)
    const page = Math.max(1, Number(query.page) || 1)
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20))

    const result = await listReportsByProductLinePaged({
      productLineId,
      issueId,
      keyword,
      statuses,
      levels,
      page,
      limit: pageSize,
    })
    return { data: result.data, total: result.total, page, pageSize }
  })

  app.get('/bug-analysis-reports/:id', async (req) => {
    const id = Number((req.params as any).id)
    const report = await getBugAnalysisReportById(id)
    if (!report) return { error: { code: 'NOT_FOUND', message: `report ${id} not found` } }
    return { data: report }
  })

  // 查询指定报告的所有 bug_fix_events（按 created_at 升序）
  app.get<{ Params: { id: string } }>('/bug-reports/:id/events', async (req, reply) => {
    const reportId = Number(req.params.id)
    if (!Number.isFinite(reportId)) {
      return reply.code(400).send({ error: { code: 'INVALID_ID', message: '非法的报告 ID' } })
    }
    const events = await findByReport(reportId)
    return reply.send({ data: events })
  })

  // 失败重试：基于 aborted 状态的报告，复用原 Issue 再次分析
  app.post<{ Params: { id: string } }>('/bug-reports/:id/retry', async (req, reply) => {
    const reportId = Number(req.params.id)
    if (!Number.isFinite(reportId)) {
      return reply.code(400).send({ success: false, error: 'INVALID_ID', message: '非法的报告 ID' })
    }

    const report = await getBugAnalysisReportById(reportId)
    if (!report) {
      return reply.code(404).send({ success: false, error: 'REPORT_NOT_FOUND', message: '报告不存在' })
    }

    if (report.status !== 'aborted') {
      return reply.code(409).send({
        success: false,
        error: 'REPORT_NOT_RETRYABLE',
        message: `报告状态为 ${report.status}，无需重试`,
      })
    }

    if (!report.issueId) {
      return reply.code(409).send({ success: false, error: 'NO_ISSUE', message: '报告无关联 Issue，无法复用' })
    }

    try {
      const initiatorId = (req as any).user?.id ?? 'admin'

      // Fire-and-forget：立即返回"已受理"，后台跑 handleAnalyzeBug（3-6 分钟）+ Pipeline。
      // 用户刷新 BugRunsPage 会看到新 report 逐步出现；同步等会 HTTP 超时。
      void (async () => {
        try {
          const analyzerResult = await handleAnalyzeBug({
            capabilityKey: 'analyze_bug',
            context: {
              taskId: `retry-${reportId}`,
              groupId: 'admin',
              platform: 'admin',
              initiatorId,
              initiatorRole: 'admin',
            },
            extraParams: {
              productLineId: report.productLineId,
              reuseIssueId: report.issueId,
              message: `[重试] 基于 Issue #${report.issueId} 的历史内容重新分析`,
            },
          })

          if (!analyzerResult.success) {
            console.error(`[admin] retry async analyze failed reportId=${reportId}:`, analyzerResult.output ?? analyzerResult.error)
            return
          }

          const data = (analyzerResult.data ?? {}) as Record<string, unknown>
          const newReportId = data.reportId as number
          const newLevel = data.level as string
          const newClass = data.classification as string

          if (newClass === 'bug') {
            await handleAnalysisComplete(newReportId, newLevel, newClass, 'admin')
          }
        } catch (err) {
          console.error(`[admin] retry async pipeline error reportId=${reportId}:`, (err as Error).message ?? err)
        }
      })()

      return reply.send({
        success: true,
        data: {
          reportId,
          message: '已受理，后台分析中。3-6 分钟后请刷新列表查看新 report（复用原 Issue）',
          issueId: report.issueId,
          issueUrl: report.issueUrl,
        },
      })
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err)
      console.error('[admin] retry endpoint error:', msg)
      return reply.code(500).send({ success: false, error: 'INTERNAL_ERROR', message: msg })
    }
  })

  /**
   * POST /bug-reports/:id/handover
   * 用户主动把 Bug 转人工接手（V2 MVP 触发源：user_requested）。
   * Body: { comment?: string } — 可选，用户说明转人工原因
   * 状态要求：status in (draft, published, pipeline_success, aborted)
   * - pending_manual：已在 handover 中 → 409
   * - completed：修复已合并，无需转人工 → 409（如需重新处理用 /retry）
   */
  app.post<{ Params: { id: string }; Body: { comment?: string } }>(
    '/bug-reports/:id/handover',
    async (req, reply) => {
      const reportId = Number(req.params.id)
      if (!Number.isFinite(reportId)) {
        return reply.code(400).send({ success: false, error: 'INVALID_ID', message: '非法的报告 ID' })
      }

      const report = await getBugAnalysisReportById(reportId)
      if (!report) {
        return reply.code(404).send({ success: false, error: 'REPORT_NOT_FOUND', message: '报告不存在' })
      }

      const allowed: ReportStatus[] = ['draft', 'published', 'pipeline_success', 'aborted']
      if (!allowed.includes(report.status)) {
        return reply.code(409).send({
          success: false,
          error: 'INVALID_STATUS',
          message: `当前 status=${report.status}，不允许转人工（仅 draft/published/pipeline_success/aborted 可触发）`,
        })
      }

      const body = (req.body ?? {}) as { comment?: string }
      const comment = typeof body.comment === 'string' && body.comment.trim().length > 0
        ? body.comment.trim()
        : undefined

      try {
        const initiatorId = (req as any).user?.id ?? 'admin'
        await checkAndTriggerHandover(
          reportId,
          'user_requested',
          initiatorId,
          comment ? { comment } : undefined,
        )
        const reloaded = await getBugAnalysisReportById(reportId)
        return reply.send({
          success: true,
          data: {
            reportId,
            status: reloaded?.status ?? report.status,
          },
        })
      } catch (err) {
        const msg = (err as Error)?.message ?? String(err)
        console.error('[admin] handover endpoint error:', msg)
        return reply.code(500).send({ success: false, error: 'INTERNAL_ERROR', message: msg })
      }
    },
  )

  /**
   * POST /bug-reports/:id/force-abort
   * 管理员强制把 report 标记为 aborted，打破卡死状态（如 Pipeline 进程中途被 kill、stage 无自动超时等场景）。
   *
   * 允许状态：published / pipeline_success（卡住的两种非终态）+ aborted（幂等）。
   * - completed（MR 已合并）拒绝 409
   * - draft / pending_manual 拒绝 409（各有专属流程）
   *
   * 标记后前端"重试"按钮会显示，让用户走整条 Pipeline 重跑路径。
   */
  app.post<{ Params: { id: string }; Body: { reason?: string } }>(
    '/bug-reports/:id/force-abort',
    async (req, reply) => {
      const reportId = Number(req.params.id)
      if (!Number.isFinite(reportId)) {
        return reply.code(400).send({ success: false, error: 'INVALID_ID', message: '非法的报告 ID' })
      }

      const report = await getBugAnalysisReportById(reportId)
      if (!report) {
        return reply.code(404).send({ success: false, error: 'REPORT_NOT_FOUND', message: '报告不存在' })
      }

      const allowed: ReportStatus[] = ['published', 'pipeline_success', 'aborted']
      if (!allowed.includes(report.status)) {
        return reply.code(409).send({
          success: false,
          error: 'INVALID_STATUS',
          message: `当前 status=${report.status}，不允许强制终止（仅 published/pipeline_success/aborted 可强制终止）`,
        })
      }

      const body = (req.body ?? {}) as { reason?: string }
      const reason = typeof body.reason === 'string' && body.reason.trim().length > 0
        ? body.reason.trim()
        : '管理员手动强制终止'

      try {
        const initiatorId = (req as any).user?.id ?? 'admin'
        await updateReportStatus(reportId, 'aborted')
        await createEvent({
          reportId,
          projectPath: null,
          code: 'lifecycle_sync',
          status: 'success',
          data: {
            targetStatus: 'aborted',
            source: 'force_abort',
            initiatorId,
            reason,
            previousStatus: report.status,
          },
        })
        const reloaded = await getBugAnalysisReportById(reportId)
        return reply.send({
          success: true,
          data: {
            reportId,
            status: reloaded?.status ?? 'aborted',
          },
        })
      } catch (err) {
        const msg = (err as Error)?.message ?? String(err)
        console.error('[admin] force-abort endpoint error:', msg)
        return reply.code(500).send({ success: false, error: 'INTERNAL_ERROR', message: msg })
      }
    },
  )
}
