import { getPool } from '../client.js'

export type ScenarioResult = 'pass' | 'fail' | 'error' | 'timeout' | 'skipped' | 'unfixable'

export interface E2eScenarioRun {
  id: bigint
  e2eRunId: bigint
  scenarioId: string
  scenarioName: string | null
  attemptNumber: number
  result: ScenarioResult
  durationMs: number | null
  evidenceManifest: Record<string, unknown> | null
  evidenceDirUri: string | null
  linkedBugReportId: bigint | null
  startedAt: Date
  finishedAt: Date | null
}

function mapRow(r: Record<string, unknown>): E2eScenarioRun {
  return {
    id: r.id as bigint,
    e2eRunId: r.e2e_run_id as bigint,
    scenarioId: r.scenario_id as string,
    scenarioName: r.scenario_name as string | null,
    attemptNumber: r.attempt_number as number,
    result: r.result as ScenarioResult,
    durationMs: r.duration_ms as number | null,
    evidenceManifest: r.evidence_manifest as Record<string, unknown> | null,
    evidenceDirUri: r.evidence_dir_uri as string | null,
    linkedBugReportId: r.linked_bug_report_id as bigint | null,
    startedAt: r.started_at as Date,
    finishedAt: r.finished_at as Date | null,
  }
}

export async function createScenarioRun(
  data: Pick<E2eScenarioRun, 'e2eRunId' | 'scenarioId' | 'scenarioName' | 'attemptNumber'>,
): Promise<E2eScenarioRun> {
  const { rows } = await getPool().query(
    `INSERT INTO e2e_scenario_runs (e2e_run_id, scenario_id, scenario_name, attempt_number, result, started_at)
     VALUES ($1, $2, $3, $4, 'error', NOW()) RETURNING *`,
    [data.e2eRunId, data.scenarioId, data.scenarioName, data.attemptNumber],
  )
  return mapRow(rows[0])
}

export async function finishScenarioRun(
  id: bigint,
  result: ScenarioResult,
  extra?: { durationMs?: number; evidenceManifest?: Record<string, unknown>; evidenceDirUri?: string },
): Promise<void> {
  await getPool().query(
    `UPDATE e2e_scenario_runs SET
       result = $2, finished_at = NOW(),
       duration_ms = COALESCE($3, duration_ms),
       evidence_manifest = COALESCE($4::jsonb, evidence_manifest),
       evidence_dir_uri = COALESCE($5, evidence_dir_uri)
     WHERE id = $1`,
    [id, result, extra?.durationMs ?? null, extra?.evidenceManifest ? JSON.stringify(extra.evidenceManifest) : null, extra?.evidenceDirUri ?? null],
  )
}

export async function listScenarioRuns(e2eRunId: bigint): Promise<E2eScenarioRun[]> {
  const { rows } = await getPool().query(
    'SELECT * FROM e2e_scenario_runs WHERE e2e_run_id = $1 ORDER BY scenario_id, attempt_number',
    [e2eRunId],
  )
  return rows.map(mapRow)
}

export async function getLatestAttemptNumber(e2eRunId: bigint, scenarioId: string): Promise<number> {
  const { rows } = await getPool().query(
    'SELECT COALESCE(MAX(attempt_number), 0) AS n FROM e2e_scenario_runs WHERE e2e_run_id = $1 AND scenario_id = $2',
    [e2eRunId, scenarioId],
  )
  return rows[0].n as number
}
