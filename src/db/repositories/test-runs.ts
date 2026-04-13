import { getPool } from '../client.js'

export interface TestRun {
  id: number
  pipelineId: number
  triggerType: 'manual' | 'api' | 'scheduled'
  triggeredBy: string
  status: 'pending' | 'running' | 'success' | 'failed' | 'cancelled'
  servers: Record<string, string[]>
  currentStage: number
  stageResults: StageResult[]
  reportPath: string
  startedAt: Date | null
  finishedAt: Date | null
  errorMessage: string
  createdAt: Date
}

export interface StageResult {
  name: string
  type: string
  status: 'pending' | 'running' | 'success' | 'failed' | 'skipped'
  startedAt?: string
  finishedAt?: string
  durationMs?: number
  output?: string
  error?: string
}

function mapRow(r: Record<string, unknown>): TestRun {
  return {
    id: r.id as number, pipelineId: r.pipeline_id as number,
    triggerType: r.trigger_type as TestRun['triggerType'],
    triggeredBy: (r.triggered_by ?? '') as string,
    status: r.status as TestRun['status'],
    servers: (r.servers ?? {}) as Record<string, string[]>,
    currentStage: r.current_stage as number,
    stageResults: (r.stage_results ?? []) as StageResult[],
    reportPath: (r.report_path ?? '') as string,
    startedAt: r.started_at as Date | null,
    finishedAt: r.finished_at as Date | null,
    errorMessage: (r.error_message ?? '') as string,
    createdAt: r.created_at as Date,
  }
}

export async function listTestRuns(pipelineId?: number, limit = 50): Promise<TestRun[]> {
  const pool = getPool()
  if (pipelineId) {
    const { rows } = await pool.query(
      'SELECT * FROM test_runs WHERE pipeline_id = $1 ORDER BY id DESC LIMIT $2', [pipelineId, limit])
    return rows.map(mapRow)
  }
  const { rows } = await pool.query('SELECT * FROM test_runs ORDER BY id DESC LIMIT $1', [limit])
  return rows.map(mapRow)
}

export async function getTestRunById(id: number): Promise<TestRun | null> {
  const pool = getPool()
  const { rows } = await pool.query('SELECT * FROM test_runs WHERE id = $1', [id])
  return rows[0] ? mapRow(rows[0]) : null
}

export async function createTestRun(data: {
  pipelineId: number; triggerType: TestRun['triggerType']; triggeredBy: string
  servers: Record<string, string[]>
}): Promise<TestRun> {
  const pool = getPool()
  const { rows } = await pool.query(
    `INSERT INTO test_runs (pipeline_id, trigger_type, triggered_by, servers, status, started_at)
     VALUES ($1,$2,$3,$4,'running',NOW()) RETURNING *`,
    [data.pipelineId, data.triggerType, data.triggeredBy, JSON.stringify(data.servers)]
  )
  return mapRow(rows[0])
}

export async function updateTestRunStage(id: number, currentStage: number, stageResults: StageResult[]): Promise<void> {
  const pool = getPool()
  await pool.query(
    'UPDATE test_runs SET current_stage = $2, stage_results = $3 WHERE id = $1',
    [id, currentStage, JSON.stringify(stageResults)]
  )
}

export async function finishTestRun(id: number, status: 'success' | 'failed' | 'cancelled', reportPath: string, errorMessage = ''): Promise<void> {
  const pool = getPool()
  await pool.query(
    'UPDATE test_runs SET status = $2, report_path = $3, error_message = $4, finished_at = NOW() WHERE id = $1',
    [id, status, reportPath, errorMessage]
  )
}
