import { getPool } from '../client.js'

export interface BugFixEvent {
  id: number
  reportId: number
  projectPath: string | null
  code: string
  status: 'success' | 'failed'
  durationMs: number | null
  data: Record<string, unknown>
  createdAt: Date
}

interface CreateEventInput {
  reportId: number
  projectPath: string | null
  code: string
  status?: 'success' | 'failed'
  durationMs?: number
  data?: Record<string, unknown>
}

function mapRow(r: Record<string, unknown>): BugFixEvent {
  return {
    id: r.id as number,
    reportId: r.report_id as number,
    projectPath: r.project_path as string | null,
    code: r.code as string,
    status: r.status as 'success' | 'failed',
    durationMs: r.duration_ms as number | null,
    data: (r.data ?? {}) as Record<string, unknown>,
    createdAt: r.created_at as Date,
  }
}

export async function createEvent(input: CreateEventInput): Promise<BugFixEvent> {
  const pool = getPool()
  const { rows } = await pool.query(
    `INSERT INTO bug_fix_events (report_id, project_path, code, status, duration_ms, data)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      input.reportId,
      input.projectPath,
      input.code,
      input.status ?? 'success',
      input.durationMs ?? null,
      JSON.stringify(input.data ?? {}),
    ],
  )
  return mapRow(rows[0])
}

export async function findByReport(reportId: number): Promise<BugFixEvent[]> {
  const pool = getPool()
  const { rows } = await pool.query(
    `SELECT * FROM bug_fix_events WHERE report_id = $1 ORDER BY created_at ASC, id ASC`,
    [reportId],
  )
  return rows.map(mapRow)
}

export async function findByReportCode(reportId: number, code: string): Promise<BugFixEvent[]> {
  const pool = getPool()
  const { rows } = await pool.query(
    `SELECT * FROM bug_fix_events WHERE report_id = $1 AND code = $2 ORDER BY created_at ASC, id ASC`,
    [reportId, code],
  )
  return rows.map(mapRow)
}

export async function findDistinctProjects(reportId: number): Promise<string[]> {
  const pool = getPool()
  const { rows } = await pool.query(
    `SELECT DISTINCT project_path FROM bug_fix_events
     WHERE report_id = $1 AND project_path IS NOT NULL`,
    [reportId],
  )
  return rows.map(r => r.project_path as string)
}

export async function findLatest(
  reportId: number,
  projectPath: string | null,
  code: string,
): Promise<BugFixEvent | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    `SELECT * FROM bug_fix_events
     WHERE report_id = $1 AND project_path IS NOT DISTINCT FROM $2 AND code = $3
     ORDER BY id DESC LIMIT 1`,
    [reportId, projectPath, code],
  )
  return rows[0] ? mapRow(rows[0]) : null
}

export async function findPrimaryCreateIssue(reportId: number): Promise<BugFixEvent | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    `SELECT * FROM bug_fix_events
     WHERE report_id = $1 AND code = 'create_issue' AND (data->>'isPrimary')::boolean = true
     ORDER BY id DESC LIMIT 1`,
    [reportId],
  )
  return rows[0] ? mapRow(rows[0]) : null
}
