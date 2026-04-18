import { getPool } from '../client.js'

export interface BugAnalysisStat {
  id: number
  reportId: number | null
  durationMs: number
  cacheHit: boolean
  tokenCount: number | null
  createdAt: Date
}

function mapRow(r: Record<string, unknown>): BugAnalysisStat {
  return {
    id: r.id as number,
    reportId: r.report_id as number | null,
    durationMs: r.duration_ms as number,
    cacheHit: r.cache_hit as boolean,
    tokenCount: r.token_count as number | null,
    createdAt: r.created_at as Date,
  }
}

export async function createStat(
  data: Pick<BugAnalysisStat, 'reportId' | 'durationMs' | 'cacheHit' | 'tokenCount'>
): Promise<BugAnalysisStat> {
  const pool = getPool()
  const { rows } = await pool.query(
    `INSERT INTO bug_analysis_stats (report_id, duration_ms, cache_hit, token_count)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [data.reportId ?? null, data.durationMs, data.cacheHit, data.tokenCount ?? null]
  )
  return mapRow(rows[0])
}

export async function getAvgDuration(productLineId: number, fromDate: Date): Promise<number | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    `SELECT AVG(bas.duration_ms)::int as avg_ms
     FROM bug_analysis_stats bas
     JOIN bug_analysis_reports bar ON bas.report_id = bar.id
     WHERE bar.product_line_id = $1 AND bas.created_at >= $2`,
    [productLineId, fromDate]
  )
  return rows[0]?.avg_ms ?? null
}
