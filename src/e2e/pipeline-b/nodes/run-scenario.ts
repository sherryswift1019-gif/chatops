// src/e2e/pipeline-b/nodes/run-scenario.ts
import { join } from 'path'
import { mkdirSync } from 'fs'
import { getE2eTargetProject } from '../../../db/repositories/e2e-target-projects.js'
import {
  createScenarioRun,
  finishScenarioRun,
  getLatestAttemptNumber,
} from '../../../db/repositories/e2e-scenario-runs.js'
import { updateE2eRunStatus } from '../../../db/repositories/e2e-runs.js'
import { runScript } from '../run-script.js'
import { notifyScenarioFailed } from '../im-notifier.js'
import type { PipelineBStateType } from '../types.js'

export async function runScenarioNode(state: PipelineBStateType): Promise<Partial<PipelineBStateType>> {
  const { currentScenario, runId, targetProjectId, governorState } = state
  if (!currentScenario) throw new Error('run-scenario: currentScenario is null')

  const project = await getE2eTargetProject(targetProjectId)
  if (!project) throw new Error(`e2e_target_projects: "${targetProjectId}" not found`)

  const workDir = project.workingDir ?? '.'
  const testScript = join(workDir, state.projectScripts.test)

  const attemptNumber = (await getLatestAttemptNumber(runId, currentScenario.id)) + 1

  const evidenceRoot = process.env.E2E_EVIDENCE_ROOT ?? '/var/chatops/e2e-evidence'
  const safeScenarioId = currentScenario.id.replace(/[^a-zA-Z0-9_\-]/g, '_')
  const evidenceDir = join(evidenceRoot, String(runId), safeScenarioId, String(attemptNumber))
  mkdirSync(evidenceDir, { recursive: true })

  const scenarioRunRecord = await createScenarioRun({
    e2eRunId: runId,
    scenarioId: currentScenario.id,
    scenarioName: currentScenario.name,
    attemptNumber,
  })

  await updateE2eRunStatus(runId, 'running')

  const timeoutSec = Math.max(60, (governorState.limits.maxRunHours * 3600) / Math.max(1, state.pendingScenarios.length))
  const result = await runScript(
    testScript,
    ['--scenario', currentScenario.id, `--evidence-dir=${evidenceDir}`, `--timeout=${Math.floor(timeoutSec)}`],
    { timeout: (timeoutSec + 30) * 1000, cwd: workDir },
  )

  let scenarioResult: 'pass' | 'fail' | 'error' | 'timeout' = 'error'
  if (result.exitCode === 0) {
    scenarioResult = 'pass'
  } else if (result.exitCode === 1) {
    scenarioResult = (result.parsed?.result as string) === 'timeout' ? 'timeout' : 'fail'
  } else if (result.exitCode === -1) {
    scenarioResult = 'timeout'
  }

  const durationMs = typeof result.parsed?.duration_ms === 'number' ? result.parsed.duration_ms : undefined

  await finishScenarioRun(scenarioRunRecord.id, scenarioResult, {
    durationMs,
    evidenceDirUri: evidenceDir,
  })

  const newGovernorState = {
    ...governorState,
    totalAttempts: governorState.totalAttempts + 1,
    perScenarioAttempts: {
      ...governorState.perScenarioAttempts,
      [currentScenario.id]: (governorState.perScenarioAttempts[currentScenario.id] ?? 0) + 1,
    },
    totalElapsedMs: Date.now() - governorState.runStartedAt,
  }

  console.log(`[PipelineB:runScenario] runId=${runId} scenario=${currentScenario.id} attempt=${attemptNumber} result=${scenarioResult}`)
  if (scenarioResult !== 'pass' && state.imContext) {
    notifyScenarioFailed(
      { adapter: state.imContext.adapter, groupId: state.imContext.groupId, runId },
      currentScenario.id,
    ).catch(() => {})
  }
  return {
    lastScenarioResult: scenarioResult,
    currentScenarioRunId: scenarioRunRecord.id,
    evidenceDirTemp: evidenceDir,
    governorState: newGovernorState,
  }
}
