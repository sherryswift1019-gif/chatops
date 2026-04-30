// src/e2e/pipeline-b/nodes/mark-green.ts
import type { PipelineBStateType } from '../types.js'

export async function markGreenNode(state: PipelineBStateType): Promise<Partial<PipelineBStateType>> {
  const { currentScenario, pendingScenarios, runId } = state
  if (!currentScenario) return {}

  const remaining = pendingScenarios.filter((s) => s.id !== currentScenario.id)

  console.log(`[PipelineB:markGreen] runId=${runId} scenario=${currentScenario.id} PASSED remaining=${remaining.length}`)
  return {
    pendingScenarios: remaining,
    currentScenario: null,
    currentScenarioRunId: null,
    lastScenarioResult: null,
    lastFixResult: null,
    evidenceDirTemp: null,
  }
}
