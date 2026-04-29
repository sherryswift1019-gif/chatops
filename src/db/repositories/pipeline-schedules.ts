import { getPool } from '../client.js'

export interface PipelineSchedule {
  id: number
  pipelineId: number
  name: string
  cronExpr: string
  presetParams: Record<string, unknown>
  enabled: boolean
  createdAt: Date
  updatedAt: Date
}

function mapRow(r: Record<string, unknown>): PipelineSchedule {
  return {
    id: r.id as number,
    pipelineId: r.pipeline_id as number,
    name: (r.name ?? '') as string,
    cronExpr: r.cron_expr as string,
    presetParams: (r.preset_params ?? {}) as Record<string, unknown>,
    enabled: r.enabled as boolean,
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
  }
}

export async function listPipelineSchedules(pipelineId: number): Promise<PipelineSchedule[]> {
  const pool = getPool()
  const { rows } = await pool.query(
    'SELECT * FROM pipeline_schedules WHERE pipeline_id = $1 ORDER BY id',
    [pipelineId]
  )
  return rows.map(mapRow)
}

export async function listEnabledSchedules(): Promise<PipelineSchedule[]> {
  const pool = getPool()
  const { rows } = await pool.query(
    'SELECT * FROM pipeline_schedules WHERE enabled = true ORDER BY id'
  )
  return rows.map(mapRow)
}

export async function createPipelineSchedule(data: {
  pipelineId: number
  name?: string
  cronExpr: string
  presetParams?: Record<string, unknown>
  enabled?: boolean
}): Promise<PipelineSchedule> {
  const pool = getPool()
  const { rows } = await pool.query(
    `INSERT INTO pipeline_schedules (pipeline_id, name, cron_expr, preset_params, enabled)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [data.pipelineId, data.name ?? '', data.cronExpr,
     JSON.stringify(data.presetParams ?? {}), data.enabled ?? true]
  )
  return mapRow(rows[0])
}

export async function updatePipelineSchedule(id: number, data: Partial<{
  name: string; cronExpr: string; presetParams: Record<string, unknown>; enabled: boolean
}>): Promise<PipelineSchedule | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    `UPDATE pipeline_schedules SET
       name       = COALESCE($2, name),
       cron_expr  = COALESCE($3, cron_expr),
       preset_params = COALESCE($4, preset_params),
       enabled    = COALESCE($5, enabled),
       updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id, data.name ?? null, data.cronExpr ?? null,
     data.presetParams ? JSON.stringify(data.presetParams) : null,
     data.enabled ?? null]
  )
  return rows[0] ? mapRow(rows[0]) : null
}

export async function deletePipelineSchedule(id: number): Promise<boolean> {
  const pool = getPool()
  const { rowCount } = await pool.query('DELETE FROM pipeline_schedules WHERE id = $1', [id])
  return (rowCount ?? 0) > 0
}

export async function getPipelineScheduleById(id: number): Promise<PipelineSchedule | null> {
  const pool = getPool()
  const { rows } = await pool.query('SELECT * FROM pipeline_schedules WHERE id = $1', [id])
  return rows[0] ? mapRow(rows[0]) : null
}
