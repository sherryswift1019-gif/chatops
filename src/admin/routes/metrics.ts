import type { FastifyInstance } from 'fastify'
import { getMetricRange } from '../../db/repositories/metrics-daily.js'
import { getTopHits } from '../../db/repositories/knowledge-hit-stats.js'
import { getAvgDuration } from '../../db/repositories/bug-analysis-stats.js'
import { countByType } from '../../db/repositories/root-cause-attribution.js'

export async function registerMetricsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/metrics/daily', async (req) => {
    const query = req.query as any
    const productLineId = query.product_line_id ? Number(query.product_line_id) : null
    const metricKey = query.metric_key as string
    const from = query.from ? new Date(query.from) : new Date(Date.now() - 30 * 86400000)
    const to = query.to ? new Date(query.to) : new Date()
    if (!metricKey) return { error: { code: 'MISSING_PARAM', message: 'metric_key required' } }
    return { data: await getMetricRange(productLineId, metricKey, from, to) }
  })

  app.get('/metrics/knowledge-hits', async (req) => {
    const productLineId = Number((req.query as any).product_line_id)
    const limit = Number((req.query as any).limit) || 20
    if (!productLineId) return { error: { code: 'MISSING_PARAM', message: 'product_line_id required' } }
    return { data: await getTopHits(productLineId, limit) }
  })

  app.get('/metrics/avg-duration', async (req) => {
    const productLineId = Number((req.query as any).product_line_id)
    const from = (req.query as any).from ? new Date((req.query as any).from) : new Date(Date.now() - 30 * 86400000)
    if (!productLineId) return { error: { code: 'MISSING_PARAM', message: 'product_line_id required' } }
    return { data: { avgDurationMs: await getAvgDuration(productLineId, from) } }
  })

  app.get('/metrics/root-cause-trends', async (req) => {
    const productLineId = Number((req.query as any).product_line_id)
    const from = (req.query as any).from ? new Date((req.query as any).from) : new Date(Date.now() - 90 * 86400000)
    if (!productLineId) return { error: { code: 'MISSING_PARAM', message: 'product_line_id required' } }
    return { data: await countByType(productLineId, from) }
  })
}
