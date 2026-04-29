import { Annotation } from '@langchain/langgraph'
import type { StageResult } from '../db/repositories/test-runs.js'

// Re-export StageResult so graph-builder / executor / tests can import it
// from the graph-state module without reaching into the DB layer.
export type { StageResult }

// Merge a single StageResult into an existing list by `name`:
// - if an entry with the same name exists, overwrite it in place;
// - otherwise append.
// The reducer accepts either a single StageResult or a StageResult[].
export type StageResultsUpdate = StageResult | StageResult[]

export function mergeStageResults(
  current: StageResult[],
  update: StageResultsUpdate | undefined,
): StageResult[] {
  if (!update) return current
  const incoming = Array.isArray(update) ? update : [update]
  if (incoming.length === 0) return current
  const byName = new Map<string, number>()
  const next = current.slice()
  next.forEach((r, idx) => byName.set(r.name, idx))
  for (const r of incoming) {
    const existingIdx = byName.get(r.name)
    if (existingIdx === undefined) {
      byName.set(r.name, next.length)
      next.push(r)
    } else {
      next[existingIdx] = r
    }
  }
  return next
}

// Per-node executor outputs keyed by node id. Used by the dispatcher in
// graph-builder for resolving `{{steps.<id>.output.x}}` templates and by
// node-types fan_out/template_render for step references.
//
// Node ids are unique within a pipeline graph, so we accept a partial-merge
// reducer (later writes overwrite earlier ones). v1 doesn't support a node
// firing twice in the same run.
export interface StepOutput {
  status: 'success' | 'failed' | 'skipped'
  output: Record<string, unknown>
}

// StateGraph runtime state for a pipeline run.
//
// Reducer choices match the semantics the executor needs:
// - currentStageIndex / terminated: simple "latest wins" with sticky logic
//   where appropriate (terminated latches to true).
// - stageResults: per-stage merge/overwrite keyed by `name`, so a node can
//   publish its own result without clobbering peers.
// - runtimeVars: shallow object merge, matching how the SSH/script stages
//   already accumulate variables on test_runs.runtime_vars.
// - stepOutputs: per-node-id merge so executor nodes can read upstream
//   structured outputs via `{{steps.<id>.output.x}}` templates.
export const PipelineStateAnnotation = Annotation.Root({
  runId: Annotation<number>({
    reducer: (current, update) => update ?? current,
    default: () => 0,
  }),
  currentStageIndex: Annotation<number>({
    reducer: (current, update) => (update !== undefined ? update : current),
    default: () => 0,
  }),
  stageResults: Annotation<StageResult[], StageResultsUpdate>({
    reducer: mergeStageResults,
    default: () => [],
  }),
  runtimeVars: Annotation<Record<string, unknown>>({
    reducer: (current, update) => ({ ...current, ...(update ?? {}) }),
    default: () => ({}),
  }),
  stepOutputs: Annotation<Record<string, StepOutput>>({
    reducer: (current, update) => ({ ...current, ...(update ?? {}) }),
    default: () => ({}),
  }),
  terminated: Annotation<boolean>({
    // OR reducer: once true, never flips back.
    reducer: (current, update) => current || !!update,
    default: () => false,
  }),
})

export type PipelineState = typeof PipelineStateAnnotation.State
export type PipelineStateUpdate = typeof PipelineStateAnnotation.Update
