import { getPool } from '../client.js'

export type BugLevel = 'l1' | 'l2' | 'l3' | 'l4'
export type BugClassification = 'bug' | 'config_issue' | 'usage_issue'
export type ConfidenceLevel = 'high' | 'medium' | 'low'
export type ReportStatus =
  | 'draft'
  | 'published'
  | 'pipeline_success'
  | 'pending_manual'
  | 'completed'
  | 'aborted'

export interface Solution {
  id: string
  summary: string
  recommended: boolean
  risk: string
  effort: string
}

export interface BugAnalysisReport {
  id: number
  issueId: number
  issueUrl: string
  productLineId: number
  agentSessionId: string | null
  level: BugLevel
  classification: BugClassification
  confidence: ConfidenceLevel
  confidenceScore: number | null
  rootCauseSummary: string | null
  solutionsJson: Solution[]
  affectedModules: string[] | null
  analysisSteps: string[] | null
  metadata: Record<string, unknown> | null
  status: ReportStatus
  pipelineRunId: number | null
  primaryProjectPath: string | null
  createdAt: Date
  updatedAt: Date
  completedAt: Date | null
  productLineName?: string
}

function mapRow(r: Record<string, unknown>): BugAnalysisReport {
  return {
    id: r.id as number,
    issueId: r.issue_id as number,
    issueUrl: r.issue_url as string,
    productLineId: r.product_line_id as number,
    agentSessionId: r.agent_session_id as string | null,
    level: r.level as BugLevel,
    classification: r.classification as BugClassification,
    confidence: r.confidence as ConfidenceLevel,
    confidenceScore: r.confidence_score as number | null,
    rootCauseSummary: r.root_cause_summary as string | null,
    solutionsJson: (r.solutions_json ?? []) as Solution[],
    affectedModules: r.affected_modules as string[] | null,
    analysisSteps: r.analysis_steps as string[] | null,
    metadata: r.metadata as Record<string, unknown> | null,
    status: r.status as ReportStatus,
    pipelineRunId: (r.pipeline_run_id as number | null) ?? null,
    primaryProjectPath: (r.primary_project_path as string | null) ?? null,
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
    completedAt: (r.completed_at ?? null) as Date | null,
    productLineName: r.product_line_name as string | undefined,
  }
}

export async function createBugAnalysisReport(
  data: Pick<BugAnalysisReport, 'issueId' | 'issueUrl' | 'productLineId' | 'agentSessionId' | 'level' | 'classification' | 'confidence' | 'confidenceScore' | 'rootCauseSummary' | 'solutionsJson' | 'affectedModules' | 'analysisSteps' | 'metadata'> & {
    primaryProjectPath?: string | null
  }
): Promise<BugAnalysisReport> {
  const pool = getPool()
  const { rows } = await pool.query(
    `INSERT INTO bug_analysis_reports
       (issue_id, issue_url, product_line_id, agent_session_id, level, classification, confidence, confidence_score, root_cause_summary, solutions_json, affected_modules, analysis_steps, metadata, primary_project_path)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [data.issueId, data.issueUrl, data.productLineId, data.agentSessionId ?? null,
     data.level, data.classification, data.confidence, data.confidenceScore ?? null,
     data.rootCauseSummary ?? null, JSON.stringify(data.solutionsJson),
     data.affectedModules ? JSON.stringify(data.affectedModules) : null,
     data.analysisSteps ? JSON.stringify(data.analysisSteps) : null,
     data.metadata ? JSON.stringify(data.metadata) : null,
     data.primaryProjectPath ?? null]
  )
  return mapRow(rows[0])
}

export async function setPipelineRunId(reportId: number, runId: number): Promise<void> {
  const pool = getPool()
  await pool.query(
    `UPDATE bug_analysis_reports SET pipeline_run_id = $2, updated_at = NOW() WHERE id = $1`,
    [reportId, runId],
  )
}

export async function getBugAnalysisReportById(id: number): Promise<BugAnalysisReport | null> {
  const pool = getPool()
  const { rows } = await pool.query('SELECT * FROM bug_analysis_reports WHERE id = $1', [id])
  return rows[0] ? mapRow(rows[0]) : null
}

export async function getBugAnalysisReportByIssueId(issueId: number): Promise<BugAnalysisReport | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    'SELECT * FROM bug_analysis_reports WHERE issue_id = $1 ORDER BY created_at DESC LIMIT 1',
    [issueId]
  )
  return rows[0] ? mapRow(rows[0]) : null
}

const TERMINAL_STATUSES: ReadonlySet<ReportStatus> = new Set<ReportStatus>([
  'completed',
  'aborted',
  'pending_manual',
])

export async function updateReportStatus(id: number, status: ReportStatus): Promise<BugAnalysisReport | null> {
  const pool = getPool()
  if (TERMINAL_STATUSES.has(status)) {
    // 终态：幂等写入 completed_at（已非空时保留原值）
    const { rows } = await pool.query(
      `UPDATE bug_analysis_reports
         SET status = $2,
             updated_at = NOW(),
             completed_at = COALESCE(completed_at, NOW())
       WHERE id = $1
       RETURNING *`,
      [id, status],
    )
    return rows[0] ? mapRow(rows[0]) : null
  }
  const { rows } = await pool.query(
    'UPDATE bug_analysis_reports SET status = $2, updated_at = NOW() WHERE id = $1 RETURNING *',
    [id, status]
  )
  return rows[0] ? mapRow(rows[0]) : null
}

export async function listReportsByProductLine(productLineId: number, limit = 50): Promise<BugAnalysisReport[]> {
  const pool = getPool()
  const { rows } = await pool.query(
    'SELECT * FROM bug_analysis_reports WHERE product_line_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2',
    [productLineId, limit]
  )
  return rows.map(mapRow)
}

/**
 * 支持 productLineId/issueId/status/level 筛选 + 服务端分页的版本。
 *
 * - productLineId 未传 → 不按产品线过滤（跨产品线列出）
 * - issueId 未传 → 不按 Issue 过滤
 * - statuses/levels 为空/undefined 表示不过滤
 * - page 从 1 起
 * - SELECT 左联 product_lines 附带 product_line_name
 */
export async function listReportsByProductLinePaged(params: {
  productLineId?: number
  issueId?: number
  statuses?: ReportStatus[]
  levels?: BugLevel[]
  page: number
  limit: number
}): Promise<{ data: BugAnalysisReport[]; total: number }> {
  const pool = getPool()
  const { productLineId, issueId, statuses, levels, page, limit } = params

  const where: string[] = []
  const values: unknown[] = []

  if (productLineId != null) {
    values.push(productLineId)
    where.push(`b.product_line_id = $${values.length}`)
  }
  if (issueId != null) {
    values.push(issueId)
    where.push(`b.issue_id = $${values.length}`)
  }
  if (statuses && statuses.length > 0) {
    values.push(statuses)
    where.push(`b.status = ANY($${values.length}::text[])`)
  }
  if (levels && levels.length > 0) {
    values.push(levels)
    where.push(`b.level = ANY($${values.length}::text[])`)
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  const offset = Math.max(0, (page - 1) * limit)

  const countValues = [...values]
  const countRes = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM bug_analysis_reports b ${whereSql}`,
    countValues,
  )
  const total = (countRes.rows[0]?.cnt as number) ?? 0

  values.push(limit)
  values.push(offset)
  const listRes = await pool.query(
    `SELECT b.*, p.name AS product_line_name
       FROM bug_analysis_reports b
       LEFT JOIN product_lines p ON p.id = b.product_line_id
       ${whereSql}
       ORDER BY b.created_at DESC, b.id DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  )

  return { data: listRes.rows.map(mapRow), total }
}
