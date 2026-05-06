// src/e2e/pipeline-b/nodes/finalize-failed.ts
import { updateE2eRunStatus } from '../../../db/repositories/e2e-runs.js'
import { notifyRunFailed } from '../im-notifier.js'
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
  const { runId, governorState, lastUnfixableScenario } = state

  const nowMs = Date.now()
  const elapsedMs = nowMs - governorState.runStartedAt
  let reason: string
  if (elapsedMs > governorState.limits.maxRunHours * 3600 * 1000) {
    reason = `over_time_limit: ${Math.round(elapsedMs / 60000)}min elapsed (limit ${governorState.limits.maxRunHours}h)`
  } else if (governorState.totalAttempts >= governorState.limits.maxTotalAttempts) {
    reason = `over_total_attempts: ${governorState.totalAttempts} (limit ${governorState.limits.maxTotalAttempts})`
  } else if (lastUnfixableScenario) {
    // mark_unfixable → finalize_failed 的 fail-fast 路径：真正原因不是预算，
    // 是某个 scenario 被判 unfixable。早期默认 reason 落到 governor_over_budget
    // 是误导。
    reason = `scenario_unfixable: ${lastUnfixableScenario}`
  } else {
    reason = 'governor_over_budget'
  }

  await updateE2eRunStatus(runId, 'failed', {
    finishedAt: new Date(),
    abortReason: reason,
  })

  if (state.imContext) {
    notifyRunFailed(
      { adapter: state.imContext.adapter, groupId: state.imContext.groupId, runId },
      reason,
    ).catch(() => {})
  }

  console.log(`[PipelineB:finalizeFailed] runId=${runId} reason=${reason}`)
  return { errorMessage: reason }
}
