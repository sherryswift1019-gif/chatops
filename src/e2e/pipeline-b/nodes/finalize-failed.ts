// src/e2e/pipeline-b/nodes/finalize-failed.ts
import { updateE2eRunStatus } from '../../../db/repositories/e2e-runs.js'
import type { PipelineBStateType } from '../types.js'

export function governorCheck(state: PipelineBStateType): 'continue' | 'over_budget' {
  const g = state.governorState
  const nowMs = Date.now()

  if (nowMs - g.runStartedAt > g.limits.maxRunHours * 3600 * 1000) {
    return 'over_budget'
  }

  if (g.totalAttempts >= g.limits.maxTotalAttempts) {
    return 'over_budget'
  }

  return 'continue'
}

export async function finalizeFailedNode(state: PipelineBStateType): Promise<Partial<PipelineBStateType>> {
  const { runId, governorState } = state

  const nowMs = Date.now()
  const elapsedMs = nowMs - governorState.runStartedAt
  let reason = 'governor_over_budget'

  if (elapsedMs > governorState.limits.maxRunHours * 3600 * 1000) {
    reason = `over_time_limit: ${Math.round(elapsedMs / 60000)}min elapsed (limit ${governorState.limits.maxRunHours}h)`
  } else if (governorState.totalAttempts >= governorState.limits.maxTotalAttempts) {
    reason = `over_total_attempts: ${governorState.totalAttempts} (limit ${governorState.limits.maxTotalAttempts})`
  }

  await updateE2eRunStatus(runId, 'failed', {
    finishedAt: new Date(),
    abortReason: reason,
  })

  console.log(`[PipelineB:finalizeFailed] runId=${runId} reason=${reason}`)
  return { errorMessage: reason }
}
