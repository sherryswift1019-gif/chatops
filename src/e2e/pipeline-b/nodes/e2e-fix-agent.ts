// src/e2e/pipeline-b/nodes/e2e-fix-agent.ts
import { getPool } from '../../../db/client.js'
import type { SandboxHandle } from '../../../db/repositories/e2e-sandboxes.js'
import { runE2eFix, type AiDiagnosis } from '../../../agent/e2e-fix/runner.js'
import { notifyBugfixComplete } from '../im-notifier.js'
import * as bus from '../scenario-event-bus.js'
import type { ImContext } from '../types.js'

export interface E2eFixAgentInput {
  sandboxHandle: SandboxHandle & { containerId?: string; workdir?: string }
  iterationBranch: string
  evidenceDir: string
  scenarioId: string
  scenarioRunId: bigint
  runId: bigint
  imContext?: ImContext
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

  bus.emit(input.runId, {
    type: 'fix_start',
    runId: input.runId.toString(),
    scenarioRunId: input.scenarioRunId.toString(),
    scenarioId: input.scenarioId,
    ts: Date.now(),
  })

  try {
    const diagnosis = await runE2eFix({
      scenarioId,
      evidenceDir,
      iterationBranch,
      containerId: sandboxHandle.containerId,
      workdir: sandboxHandle.workdir ?? '/workspace',
      runId: input.runId,
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

    if (diagnosis.success && input.imContext) {
      notifyBugfixComplete(
        { adapter: input.imContext.adapter, groupId: input.imContext.groupId, runId: scenarioRunId },
        scenarioId,
      ).catch(() => {})
    }

    bus.emit(input.runId, {
      type: 'fix_end',
      runId: input.runId.toString(),
      scenarioRunId: input.scenarioRunId.toString(),
      success: diagnosis.success,
      verdict: diagnosis.verdict,
      ts: Date.now(),
    })

    return { lastFixResult: diagnosis }
  } catch (err) {
    bus.emit(input.runId, {
      type: 'fix_end',
      runId: input.runId.toString(),
      scenarioRunId: input.scenarioRunId.toString(),
      success: false,
      verdict: 'error',
      ts: Date.now(),
    })
    throw err
  }
}
