// src/e2e/pipeline-b/nodes/e2e-fix-agent.ts
import { getPool } from '../../../db/client.js'
import type { SandboxHandle } from '../../../db/repositories/e2e-sandboxes.js'
import { runE2eFix, type AiDiagnosis } from '../../../agent/e2e-fix/runner.js'

export interface E2eFixAgentInput {
  sandboxHandle: SandboxHandle & { containerId?: string; workdir?: string }
  iterationBranch: string
  evidenceDir: string
  scenarioId: string
  scenarioRunId: bigint
}

export interface E2eFixAgentOutput {
  lastFixResult: AiDiagnosis
}

export async function e2eFixAgentNode(
  input: E2eFixAgentInput,
): Promise<E2eFixAgentOutput> {
  const { sandboxHandle, iterationBranch, evidenceDir, scenarioId, scenarioRunId } = input

  if (!sandboxHandle.containerId) {
    throw new Error('sandboxHandle.containerId is required for e2eFixAgentNode')
  }

  const diagnosis = await runE2eFix({
    scenarioId,
    evidenceDir,
    iterationBranch,
    containerId: sandboxHandle.containerId,
    workdir: sandboxHandle.workdir ?? '/workspace',
  })

  await getPool().query(
    `UPDATE e2e_scenario_runs
        SET evidence_manifest = jsonb_set(
              COALESCE(evidence_manifest, '{}'::jsonb),
              '{aiDiagnosis}',
              $1::jsonb
            )
      WHERE id = $2`,
    [JSON.stringify(diagnosis), scenarioRunId],
  )

  return { lastFixResult: diagnosis }
}
