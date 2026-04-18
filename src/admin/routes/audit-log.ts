import type { FastifyInstance } from 'fastify'
import { getPool } from '../../db/client.js'

export async function registerAuditLogRoutes(app: FastifyInstance): Promise<void> {
  app.get('/audit-log', async (req) => {
    const query = req.query as any
    const productLineId = query.product_line_id ? Number(query.product_line_id) : null
    const from = query.from ? new Date(query.from) : new Date(Date.now() - 30 * 86400000)
    const to = query.to ? new Date(query.to) : new Date()
    const limit = Math.min(Number(query.limit) || 200, 1000)

    if (productLineId !== null && (!Number.isInteger(productLineId) || productLineId <= 0)) {
      return { error: { code: 'INVALID_PARAM', message: 'product_line_id must be a positive integer' } }
    }

    const pool = getPool()

    const taskRows = (await pool.query(
      `SELECT 'task' as record_type, id::text, status, intent as description,
        initiator_id, created_at, done_at as resolved_at
      FROM tasks WHERE created_at >= $1 AND created_at <= $2
      ORDER BY created_at DESC LIMIT $3`,
      [from, to, limit]
    )).rows

    const approvalRows = (await pool.query(
      `SELECT 'approval' as record_type, id::text, status, description,
        '' as initiator_id, created_at, updated_at as resolved_at
      FROM approval_requests WHERE created_at >= $1 AND created_at <= $2
      ORDER BY created_at DESC LIMIT $3`,
      [from, to, limit]
    )).rows

    const bugParams = productLineId
      ? [from, to, limit, productLineId]
      : [from, to, limit]
    const bugRows = (await pool.query(
      `SELECT 'bug_analysis' as record_type, id::text, status, root_cause_summary as description,
        agent_session_id as initiator_id, created_at, updated_at as resolved_at
      FROM bug_analysis_reports WHERE created_at >= $1 AND created_at <= $2
      ${productLineId ? 'AND product_line_id = $4' : ''}
      ORDER BY created_at DESC LIMIT $3`,
      bugParams
    )).rows

    const allRows = [...taskRows, ...approvalRows, ...bugRows]
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, limit)

    return { data: allRows, total: allRows.length }
  })
}
