// src/e2e/pipeline-b/nodes/mark-unfixable.ts
import { finishScenarioRun } from '../../../db/repositories/e2e-scenario-runs.js'
import { notifyGovernorUnfixable } from '../im-notifier.js'
import type { PipelineBStateType } from '../types.js'

export async function markUnfixableNode(state: PipelineBStateType): Promise<Partial<PipelineBStateType>> {
  const { currentScenario, currentScenarioRunId, pendingScenarios, runId, lastFixResult } = state
  if (!currentScenario) return {}

  if (currentScenarioRunId) {
    const aiDiagnosis = lastFixResult ?? {
      verdict: 'uncertain' as const,
      rootCauseSummary: 'max fix attempts exceeded',
      fixCommitSha: null,
      fixedFiles: [],
      success: false,
      failureReason: 'exhausted all fix attempts',
    }
    await finishScenarioRun(currentScenarioRunId, 'unfixable', {
      evidenceManifest: { aiDiagnosis },
    }).catch((err) => {
      console.warn(`[PipelineB:markUnfixable] finishScenarioRun failed: ${err}`)
    })
  }

  const remaining = pendingScenarios.filter((s) => s.id !== currentScenario.id)

  console.log(`[PipelineB:markUnfixable] runId=${runId} scenario=${currentScenario.id} UNFIXABLE remaining=${remaining.length}`)
  if (state.imContext) {
    notifyGovernorUnfixable(
      { adapter: state.imContext.adapter, groupId: state.imContext.groupId, runId },
      currentScenario.id,
    ).catch(() => {})
  }
  return {
    pendingScenarios: remaining,
    currentScenario: null,
    currentScenarioRunId: null,
    lastScenarioResult: null,
    lastFixResult: null,
    evidenceDirTemp: null,
  }
}
