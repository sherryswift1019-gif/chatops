/**
 * stage-status — DB-side helpers for marking pipeline stages as "running" so
 * the admin TestRunsPage Drawer Timeline reflects the in-progress stage even
 * before the LangGraph node finalizes.
 *
 * Why this exists:
 *   build*Node callbacks in graph-builder.ts only return their stageResults
 *   patch when the node completes. While the node is running (capability LLM
 *   call, ssh exec, approval wait), the langgraph state has no entry for the
 *   stage — and persistValues writes that empty state to DB, so the Drawer
 *   Timeline can't show "in progress".
 *
 *   markStageRunning sidesteps the langgraph reducer and writes a
 *   `status:'running'` entry directly to test_runs.stage_results at node
 *   start. mergeAndPersistStageResults (used by graph-runner.persistValues)
 *   replaces the previous overwrite-write so DB-only running entries survive
 *   subsequent chunk persists until the node finalizes — at which point the
 *   langgraph state will publish a finalized entry and merge will overwrite
 *   the running entry by name.
 *
 * Race condition fix:
 *   Both markStageRunning and mergeAndPersistStageResults are read-modify-write
 *   on test_runs.stage_results. graph-builder fires markStageRunning at node
 *   entry while graph-runner streams chunks → persistValues → merge in
 *   parallel; without serialization the two writers race on the same row,
 *   each merging on top of stale `existing`, and the later writer overwrites
 *   the earlier one's entry. Symptom: running entries vanish, stage_results
 *   array order scrambles.
 *
 *   Fix: serialize all stage_results writes for a given runId via a Postgres
 *   transaction-scoped advisory lock (`pg_advisory_xact_lock(NS, runId)`).
 *   The read + merge + write happens inside the same client/transaction so
 *   nobody else can interleave. Different runs use different lock keys (the
 *   second arg is runId) so unrelated runs don't block each other.
 */

import { getPool } from '../db/client.js'
import type { PoolClient } from 'pg'
import type { StageResult, TestRun } from '../db/repositories/test-runs.js'
import { mergeStageResults } from './graph-state.js'

/**
 * Statuses that are terminal — a stage in any of these has already produced a
 * final result and must NOT be regressed back to "running" by markStageRunning
 * (e.g. when a pipeline resumes a stage that already ran in a previous run).
 *
 * Note: `cancelled` is a valid run-level finalize status but is not in the
 * stage-level StageResult.status union, so it's not listed here. If a stage
 * status enum ever grows `cancelled` it should be added.
 */
const FINALIZED: ReadonlySet<StageResult['status']> = new Set([
  'success',
  'failed',
  'skipped',
])

export interface StageDescriptor {
  name: string
  /** Either field is accepted — graph-builder uses `stageType`, executor types
   *  pass `type` in some paths. Whichever is present wins. */
  stageType?: string
  type?: string
}

/**
 * Advisory lock namespace for stage_results writes. The two-arg variant of
 * pg_advisory_xact_lock takes (int4, int4) — first arg is a fixed namespace,
 * second is the runId. Different runIds map to different lock keys.
 *
 * Value chosen: arbitrary 32-bit integer, must be stable across processes that
 * touch test_runs.stage_results so they all serialize on the same key.
 */
const STAGE_RESULTS_LOCK_NS = 0x0c4a7019

/**
 * Helper for the row-level read-modify-write critical section:
 *   BEGIN
 *   SELECT pg_advisory_xact_lock(NS, runId)
 *   read stage_results
 *   merge in JS
 *   write stage_results back
 *   COMMIT
 *
 * Uses a single PoolClient (not the pool's default round-robin) so the
 * transaction's lock and the SELECT/UPDATE are guaranteed to run on the same
 * connection — critical for advisory locks (they're per-session).
 */
async function withRunStageLock<T>(
  runId: number,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [
      STAGE_RESULTS_LOCK_NS,
      runId,
    ])
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw err
  } finally {
    client.release()
  }
}

/**
 * Read the test_runs row using a specific client (so the read participates in
 * the same transaction as the surrounding lock + write). Mirrors the subset of
 * fields the helpers actually use, so we don't need to depend on the repo's
 * mapRow (which uses the pool default connection).
 */
async function readRunForUpdate(
  client: PoolClient,
  runId: number,
): Promise<Pick<TestRun, 'currentStage' | 'stageResults'> | null> {
  const { rows } = await client.query(
    'SELECT current_stage, stage_results FROM test_runs WHERE id = $1',
    [runId],
  )
  if (rows.length === 0) return null
  const r = rows[0]
  return {
    currentStage: r.current_stage as number,
    stageResults: (r.stage_results ?? []) as StageResult[],
  }
}

async function writeStageResults(
  client: PoolClient,
  runId: number,
  currentStage: number,
  stageResults: StageResult[],
): Promise<void> {
  await client.query(
    'UPDATE test_runs SET current_stage = $2, stage_results = $3 WHERE id = $1',
    [runId, currentStage, JSON.stringify(stageResults)],
  )
}

/**
 * Mark `stage` as running in test_runs.stage_results without touching
 * current_stage. By-name merge: if an entry with the same name already exists
 * AND it's not finalized, update it to running; if it IS finalized (resume /
 * historical), leave it alone (no-op).
 *
 * Intentionally swallows all errors — failing to write a UI hint must not
 * abort the actual stage execution.
 */
export async function markStageRunning(
  runId: number,
  stage: StageDescriptor,
  startedAtIso: string,
): Promise<void> {
  try {
    await withRunStageLock(runId, async (client) => {
      const run = await readRunForUpdate(client, runId)
      if (!run) return
      const existing = run.stageResults
      const prior = existing.find((r) => r.name === stage.name)
      // Already finalized → preserve the historical record.
      if (prior && FINALIZED.has(prior.status)) return
      // Already running → don't reset startedAt (stale chunk replays / re-entry
      // would otherwise rewrite the original start time).
      if (prior && prior.status === 'running') return

      const entry: StageResult = {
        name: stage.name,
        type: stage.stageType ?? stage.type ?? 'unknown',
        status: 'running',
        startedAt: startedAtIso,
      }
      const merged = mergeStageResults(existing, entry)
      // markStageRunning does not move current_stage — it's a UI hint only;
      // keep the existing value to avoid clobbering progress made elsewhere.
      await writeStageResults(client, runId, run.currentStage, merged)
    })
  } catch (err) {
    console.warn(`[stage-status] markStageRunning failed for run ${runId}:`, err)
  }
}

/**
 * Replacement for the previous "overwrite test_runs.stage_results with
 * langgraph state" persist. Reads current DB stage_results, merges the
 * langgraph-state stageResults on top by name, and writes back.
 *
 * Net effect:
 *   - finalized langgraph entries overwrite running DB entries (good — that's
 *     what stage-finish should do)
 *   - DB-only running entries (written by markStageRunning, not yet present in
 *     langgraph state because the node hasn't finalized) are preserved
 *   - sibling stages untouched
 */
export async function mergeAndPersistStageResults(
  runId: number,
  currentStage: number,
  stateStageResults: StageResult[],
): Promise<void> {
  await withRunStageLock(runId, async (client) => {
    const run = await readRunForUpdate(client, runId)
    const existing = run?.stageResults ?? []
    const merged = mergeStageResults(existing, stateStageResults)
    await writeStageResults(client, runId, currentStage, merged)
  })
}

/**
 * Race-safe variant of "stamp aiAnalysis onto an existing finalized stage
 * entry". Used by graph-runner.annotateFailuresWithAi after an AI-driven
 * failure analysis returns. Operates by-name (not by-index) so concurrent
 * stage_results writes (e.g. a still-streaming node) can't desync the
 * positional index between read and write.
 *
 * Idempotent: if no entry with `stageName` exists OR it already has aiAnalysis,
 * the helper is a no-op.
 */
export async function mergeAiAnalysisIntoStage(
  runId: number,
  stageName: string,
  aiAnalysis: string,
): Promise<void> {
  await withRunStageLock(runId, async (client) => {
    const run = await readRunForUpdate(client, runId)
    if (!run) return
    const next = run.stageResults.slice()
    const idx = next.findIndex((r) => r.name === stageName)
    if (idx < 0) return
    if (next[idx].aiAnalysis) return
    next[idx] = { ...next[idx], aiAnalysis }
    await writeStageResults(client, runId, run.currentStage, next)
  })
}
