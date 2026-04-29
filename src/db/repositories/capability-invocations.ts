import { getPool } from '../client.js'

export interface CapabilityInvocation {
  id: number
  capabilityKey: string
  triggerType: string
  platform: string
  groupId: string
  triggeredBy: string
  taskId: string
  status: 'running' | 'success' | 'failed' | 'not_executed'
  params: Record<string, unknown>
  output: string
  errorMessage: string
  durationMs: number | null
  parentPipelineRunId: number | null
  startedAt: Date
  finishedAt: Date | null
}

const TEXT_LIMIT = 8000

function truncate(s: string): string {
  if (s.length <= TEXT_LIMIT) return s
  return s.slice(0, TEXT_LIMIT) + '...[truncated]'
}

function mapRow(r: Record<string, unknown>): CapabilityInvocation {
  return {
    id: r.id as number,
    capabilityKey: r.capability_key as string,
    triggerType: r.trigger_type as string,
    platform: (r.platform ?? '') as string,
    groupId: (r.group_id ?? '') as string,
    triggeredBy: (r.triggered_by ?? '') as string,
    taskId: (r.task_id ?? '') as string,
    status: r.status as CapabilityInvocation['status'],
    params: (r.params ?? {}) as Record<string, unknown>,
    output: (r.output ?? '') as string,
    errorMessage: (r.error_message ?? '') as string,
    durationMs: (r.duration_ms ?? null) as number | null,
    parentPipelineRunId: (r.parent_pipeline_run_id ?? null) as number | null,
    startedAt: r.started_at as Date,
    finishedAt: (r.finished_at ?? null) as Date | null,
  }
}

export async function createInvocation(data: {
  capabilityKey: string
  triggerType: string
  platform: string
  groupId: string
  triggeredBy: string
  taskId: string
  params: Record<string, unknown>
  parentPipelineRunId?: number | null
}): Promise<CapabilityInvocation> {
  const pool = getPool()
  const { rows } = await pool.query(
    `INSERT INTO capability_invocations
       (capability_key, trigger_type, platform, group_id, triggered_by, task_id,
        status, params, parent_pipeline_run_id, started_at)
     VALUES ($1,$2,$3,$4,$5,$6,'running',$7,$8,NOW())
     RETURNING *`,
    [
      data.capabilityKey,
      data.triggerType,
      data.platform,
      data.groupId,
      data.triggeredBy,
      data.taskId,
      JSON.stringify(data.params ?? {}),
      data.parentPipelineRunId ?? null,
    ],
  )
  return mapRow(rows[0])
}

export async function finishInvocation(
  id: number,
  status: 'success' | 'failed' | 'not_executed',
  output: string,
  errorMessage = '',
): Promise<void> {
  const pool = getPool()
  await pool.query(
    `UPDATE capability_invocations
        SET status = $2,
            output = $3,
            error_message = $4,
            finished_at = NOW(),
            duration_ms = EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000
      WHERE id = $1`,
    [id, status, truncate(output ?? ''), truncate(errorMessage ?? '')],
  )
}

export async function listInvocations(opts: {
  capabilityKey?: string | null
  platform?: string | null
  status?: string | null
  page: number
  limit: number
}): Promise<{ data: CapabilityInvocation[]; total: number }> {
  const pool = getPool()
  const offset = (opts.page - 1) * opts.limit
  const where: string[] = []
  const args: unknown[] = []
  if (opts.capabilityKey) {
    args.push(opts.capabilityKey)
    where.push(`capability_key = $${args.length}`)
  }
  if (opts.platform) {
    args.push(opts.platform)
    where.push(`platform = $${args.length}`)
  }
  if (opts.status) {
    args.push(opts.status)
    where.push(`status = $${args.length}`)
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const dataArgs = [...args, opts.limit, offset]
  const dataSql = `
    SELECT * FROM capability_invocations
    ${whereSql}
    ORDER BY id DESC
    LIMIT $${args.length + 1} OFFSET $${args.length + 2}
  `
  const [dataResult, countResult] = await Promise.all([
    pool.query(dataSql, dataArgs),
    pool.query(`SELECT COUNT(*) AS count FROM capability_invocations ${whereSql}`, args),
  ])

  return {
    data: dataResult.rows.map(mapRow),
    total: parseInt(countResult.rows[0].count, 10),
  }
}

export async function getInvocationById(
  id: number,
): Promise<CapabilityInvocation | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    'SELECT * FROM capability_invocations WHERE id = $1',
    [id],
  )
  return rows[0] ? mapRow(rows[0]) : null
}
