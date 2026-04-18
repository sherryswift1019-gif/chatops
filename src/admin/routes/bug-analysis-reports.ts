import type { FastifyInstance } from 'fastify'
import { getBugAnalysisReportById, listReportsByProductLine } from '../../db/repositories/bug-analysis-reports.js'
import { handleAnalyzeBug } from '../../agent/analysis/analyzer.js'
import { handleAnalysisComplete } from '../../agent/coordinator.js'

export async function registerBugAnalysisReportRoutes(app: FastifyInstance): Promise<void> {
  app.get('/bug-analysis-reports', async (req) => {
    const query = req.query as any
    const productLineId = Number(query.product_line_id)
    const limit = Number(query.limit) || 50
    if (!productLineId) return { error: { code: 'MISSING_PARAM', message: 'product_line_id required' } }
    const reports = await listReportsByProductLine(productLineId, limit)
    return { data: reports, total: reports.length }
  })

  app.get('/bug-analysis-reports/:id', async (req) => {
    const id = Number((req.params as any).id)
    const report = await getBugAnalysisReportById(id)
    if (!report) return { error: { code: 'NOT_FOUND', message: `report ${id} not found` } }
    return { data: report }
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
        return reply.code(502).send({
          success: false,
          error: 'GITLAB_API_ERROR',
          message: analyzerResult.output ?? analyzerResult.error ?? 'analyzer 调用失败',
        })
      }

      const data = (analyzerResult.data ?? {}) as Record<string, unknown>
      const newReportId = data.reportId as number
      const newLevel = data.level as string
      const newClass = data.classification as string

      let newRunId: number | undefined
      if (newClass === 'bug') {
        await handleAnalysisComplete(newReportId, newLevel, newClass, 'admin')
        const reloaded = await getBugAnalysisReportById(newReportId)
        newRunId = reloaded?.pipelineRunId ?? undefined
      }

      return reply.send({
        success: true,
        data: {
          newReportId,
          newRunId,
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
}
