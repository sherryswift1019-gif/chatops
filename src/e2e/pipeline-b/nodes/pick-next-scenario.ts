// src/e2e/pipeline-b/nodes/pick-next-scenario.ts
import type { PipelineBStateType } from '../types.js'

export async function pickNextScenarioNode(state: PipelineBStateType): Promise<Partial<PipelineBStateType>> {
  const next = state.pendingScenarios[0] ?? null

  if (!next) {
    console.log(`[PipelineB:pickNextScenario] runId=${state.runId} no pending scenarios`)
    return { currentScenario: null }
  }

  console.log(`[PipelineB:pickNextScenario] runId=${state.runId} next=${next.id} pending=${state.pendingScenarios.length}`)
  return { currentScenario: next }
}
