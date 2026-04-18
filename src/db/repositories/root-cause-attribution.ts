import { getPool } from '../client.js'

export type RootCauseType = 'syntax' | 'business_logic' | 'requirement' | 'boundary' | 'cross_module'

export interface RootCauseAttribution {
  id: number
  issueId: number
  reportId: number | null
  rootCauseType: RootCauseType
  context: string | null
  attributedBy: string | null
  attributedAt: Date
}

function mapRow(r: Record<string, unknown>): RootCauseAttribution {
  return {
    id: r.id as number,
    issueId: r.issue_id as number,
    reportId: r.report_id as number | null,
    rootCauseType: r.root_cause_type as RootCauseType,
    context: r.context as string | null,
    attributedBy: r.attributed_by as string | null,
    attributedAt: r.attributed_at as Date,
  }
}

export async function createAttribution(
  data: Pick<RootCauseAttribution, 'issueId' | 'reportId' | 'rootCauseType' | 'context' | 'attributedBy'>
): Promise<RootCauseAttribution> {
  const pool = getPool()
  const { rows } = await pool.query(
    `INSERT INTO root_cause_attributions (issue_id, report_id, root_cause_type, context, attributed_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [data.issueId, data.reportId ?? null, data.rootCauseType, data.context ?? null, data.attributedBy ?? null]
  )
  return mapRow(rows[0])
}

export async function getByIssueId(issueId: number): Promise<RootCauseAttribution[]> {
  const pool = getPool()
  const { rows } = await pool.query(
    'SELECT * FROM root_cause_attributions WHERE issue_id = $1 ORDER BY attributed_at DESC',
    [issueId]
  )
  return rows.map(mapRow)
}

export async function countByType(productLineId: number, fromDate: Date): Promise<{ rootCauseType: string; count: number }[]> {
  const pool = getPool()
  const { rows } = await pool.query(
    `SELECT rca.root_cause_type, COUNT(*)::int as count
     FROM root_cause_attributions rca
     JOIN bug_analysis_reports bar ON rca.report_id = bar.id
     WHERE bar.product_line_id = $1 AND rca.attributed_at >= $2
     GROUP BY rca.root_cause_type ORDER BY count DESC`,
    [productLineId, fromDate]
  )
  return rows as { rootCauseType: string; count: number }[]
}
