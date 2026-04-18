import { getPool } from '../client.js'

export type BugLevel = 'l1' | 'l2' | 'l3' | 'l4'
export type BugClassification = 'bug' | 'config_issue' | 'usage_issue'
export type ConfidenceLevel = 'high' | 'medium' | 'low'
export type ReportStatus =
  | 'draft'
  | 'published'
  | 'superseded'
  | 'pipeline_success'
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

export async function updateReportStatus(id: number, status: ReportStatus): Promise<BugAnalysisReport | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    'UPDATE bug_analysis_reports SET status = $2, updated_at = NOW() WHERE id = $1 RETURNING *',
    [id, status]
  )
  return rows[0] ? mapRow(rows[0]) : null
}

export async function listReportsByProductLine(productLineId: number, limit = 50): Promise<BugAnalysisReport[]> {
  const pool = getPool()
  const { rows } = await pool.query(
    'SELECT * FROM bug_analysis_reports WHERE product_line_id = $1 ORDER BY created_at DESC LIMIT $2',
    [productLineId, limit]
  )
  return rows.map(mapRow)
}
