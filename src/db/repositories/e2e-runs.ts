import { getPool } from '../client.js'

export type E2eRunStatus = 'pending' | 'running' | 'awaiting_fix' | 'passed' | 'failed' | 'aborted'

export interface E2eRun {
  id: bigint
  targetProjectId: string
  triggerType: string
  triggerActor: string | null
  sourceBranch: string
  iterationBranch: string
  scenarioFilter: Record<string, unknown> | null
  status: E2eRunStatus
  governorState: Record<string, unknown>
  summaryMrUrl: string | null
  startedAt: Date
  finishedAt: Date | null
  abortReason: string | null
}

function mapRow(r: Record<string, unknown>): E2eRun {
  return {
    id: r.id as bigint,
    targetProjectId: r.target_project_id as string,
    triggerType: r.trigger_type as string,
    triggerActor: r.trigger_actor as string | null,
    sourceBranch: r.source_branch as string,
    iterationBranch: r.iteration_branch as string,
    scenarioFilter: r.scenario_filter as Record<string, unknown> | null,
    status: r.status as E2eRunStatus,
    governorState: r.governor_state as Record<string, unknown>,
    summaryMrUrl: r.summary_mr_url as string | null,
    startedAt: r.started_at as Date,
    finishedAt: r.finished_at as Date | null,
    abortReason: r.abort_reason as string | null,
  }
}

export async function createE2eRun(
  data: Pick<E2eRun, 'targetProjectId' | 'triggerType' | 'triggerActor' | 'sourceBranch' | 'iterationBranch' | 'scenarioFilter'>,
): Promise<E2eRun> {
  const { rows } = await getPool().query(
    `INSERT INTO e2e_runs (target_project_id, trigger_type, trigger_actor, source_branch, iteration_branch, scenario_filter)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [data.targetProjectId, data.triggerType, data.triggerActor, data.sourceBranch, data.iterationBranch, data.scenarioFilter ? JSON.stringify(data.scenarioFilter) : null],
  )
  return mapRow(rows[0])
}

export async function getE2eRun(id: bigint): Promise<E2eRun | null> {
  const { rows } = await getPool().query('SELECT * FROM e2e_runs WHERE id = $1', [id])
  return rows[0] ? mapRow(rows[0]) : null
}

export async function updateE2eRunStatus(
  id: bigint,
  status: E2eRunStatus,
  extra?: { finishedAt?: Date; abortReason?: string; summaryMrUrl?: string; governorState?: Record<string, unknown> },
): Promise<void> {
  await getPool().query(
    `UPDATE e2e_runs SET
       status = $2,
       finished_at = COALESCE($3, finished_at),
       abort_reason = COALESCE($4, abort_reason),
       summary_mr_url = COALESCE($5, summary_mr_url),
       governor_state = COALESCE($6::jsonb, governor_state)
     WHERE id = $1`,
    [id, status, extra?.finishedAt ?? null, extra?.abortReason ?? null, extra?.summaryMrUrl ?? null, extra?.governorState ? JSON.stringify(extra.governorState) : null],
  )
}

export async function listInflightE2eRuns(): Promise<E2eRun[]> {
  const { rows } = await getPool().query(
    `SELECT * FROM e2e_runs WHERE status IN ('running','awaiting_fix') ORDER BY started_at`,
  )
  return rows.map(mapRow)
}
