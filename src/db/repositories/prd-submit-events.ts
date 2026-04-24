import { getPool } from '../client.js'

export interface PrdSubmitEvent {
  id: number
  submissionId: string
  projectPath: string | null
  code: string
  status: 'success' | 'failed' | 'running'
  durationMs: number | null
  data: Record<string, unknown>
  createdAt: Date
}

interface CreateEventInput {
  submissionId: string
  projectPath: string | null
  code: string
  status?: 'success' | 'failed' | 'running'
  durationMs?: number
  data?: Record<string, unknown>
}

function mapRow(r: Record<string, unknown>): PrdSubmitEvent {
  return {
    id: r.id as number,
    submissionId: r.submission_id as string,
    projectPath: r.project_path as string | null,
    code: r.code as string,
    status: r.status as 'success' | 'failed' | 'running',
    durationMs: r.duration_ms as number | null,
    data: (r.data ?? {}) as Record<string, unknown>,
    createdAt: r.created_at as Date,
  }
}

export async function createEvent(input: CreateEventInput): Promise<PrdSubmitEvent> {
  const pool = getPool()
  const { rows } = await pool.query(
    `INSERT INTO prd_submit_events (submission_id, project_path, code, status, duration_ms, data)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      input.submissionId,
      input.projectPath,
      input.code,
      input.status ?? 'success',
      input.durationMs ?? null,
      JSON.stringify(input.data ?? {}),
    ],
  )
  return mapRow(rows[0])
}

export async function findBySubmission(submissionId: string): Promise<PrdSubmitEvent[]> {
  const pool = getPool()
  const { rows } = await pool.query(
    `SELECT * FROM prd_submit_events WHERE submission_id = $1 ORDER BY created_at ASC, id ASC`,
    [submissionId],
  )
  return rows.map(mapRow)
}

export async function findBySubmissionCode(
  submissionId: string,
  code: string,
): Promise<PrdSubmitEvent[]> {
  const pool = getPool()
  const { rows } = await pool.query(
    `SELECT * FROM prd_submit_events WHERE submission_id = $1 AND code = $2 ORDER BY created_at ASC, id ASC`,
    [submissionId, code],
  )
  return rows.map(mapRow)
}

export async function findLatest(
  submissionId: string,
  code: string,
): Promise<PrdSubmitEvent | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    `SELECT * FROM prd_submit_events
     WHERE submission_id = $1 AND code = $2
     ORDER BY id DESC LIMIT 1`,
    [submissionId, code],
  )
  return rows[0] ? mapRow(rows[0]) : null
}
