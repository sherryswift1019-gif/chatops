import type { FastifyInstance } from 'fastify'
import { getBugAnalysisReportById, listReportsByProductLine } from '../../db/repositories/bug-analysis-reports.js'

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
}
