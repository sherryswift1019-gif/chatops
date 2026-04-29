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
 */

import {
  getTestRunById,
  updateTestRunStage,
  type StageResult,
} from '../db/repositories/test-runs.js'
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
    const run = await getTestRunById(runId)
    if (!run) return
    const existing = run.stageResults ?? []
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
    await updateTestRunStage(runId, run.currentStage, merged)
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
  const run = await getTestRunById(runId)
  const existing = run?.stageResults ?? []
  const merged = mergeStageResults(existing, stateStageResults)
  await updateTestRunStage(runId, currentStage, merged)
}
