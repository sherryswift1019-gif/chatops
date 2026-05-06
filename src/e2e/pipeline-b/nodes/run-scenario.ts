// src/e2e/pipeline-b/nodes/run-scenario.ts
//
// playbook-driven run-scenario：从 state.playbooks 反查 scenario 所属 playbook，
// 调 host 的 runE2eScenario（host Claude → Playwright MCP → docker exec → 写 manifest）。
// 跑完直接 finishScenarioRun + persistEvidenceDir，state.currentManifest 给后续节点用。
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  createScenarioRun,
  finishScenarioRun,
  getLatestAttemptNumber,
} from '../../../db/repositories/e2e-scenario-runs.js'
import { updateE2eRunStatus } from '../../../db/repositories/e2e-runs.js'
import { runE2eScenario } from '../../../agent/e2e-scenario/runner.js'
import { persistEvidenceDir } from '../evidence/storage.js'
import { notifyScenarioFailed } from '../im-notifier.js'
import type { Playbook } from '../playbook/types.js'
import type { PipelineBStateType } from '../types.js'

function findPlaybookForScenario(
  playbooks: Record<string, Playbook>,
  scenarioId: string,
): Playbook | null {
  for (const pb of Object.values(playbooks)) {
    if (pb.scenarios.some((s) => s.id === scenarioId)) return pb
  }
  return null
}

export async function runScenarioNode(state: PipelineBStateType): Promise<Partial<PipelineBStateType>> {
  const { currentScenario, runId, governorState, playbooks, sandboxHandle } = state
  if (!currentScenario) throw new Error('run-scenario: currentScenario is null')
  if (!sandboxHandle) throw new Error('run-scenario: sandboxHandle is null')

  const playbook = findPlaybookForScenario(playbooks, currentScenario.id)
  if (!playbook) {
    throw new Error(`run-scenario: scenario "${currentScenario.id}" 在 state.playbooks 中找不到所属 playbook`)
  }

  const attemptNumber = (await getLatestAttemptNumber(runId, currentScenario.id)) + 1
  const evidenceTempDir = mkdtempSync(join(tmpdir(), `e2e-scenario-${currentScenario.id}-`))

  const scenarioRunRecord = await createScenarioRun({
    e2eRunId: runId,
    scenarioId: currentScenario.id,
    scenarioName: currentScenario.name,
    attemptNumber,
  })
  await updateE2eRunStatus(runId, 'running')

  console.log(`[PipelineB:runScenario] runId=${runId} scenario=${currentScenario.id} attempt=${attemptNumber} 启动 host Claude`)
  const result = await runE2eScenario({
    playbook,
    scenarioId: currentScenario.id,
    evidenceDir: evidenceTempDir,
    sandboxHandle,
    attemptNumber,
  })

  // host Claude 跑挂了或 manifest 不合法 → 落 error result，仍走 fail 路径
  let scenarioResult: 'pass' | 'fail' | 'error' | 'timeout' = 'error'
  if (result.manifest) {
    scenarioResult = result.manifest.result
  } else if (result.errorMessage) {
    console.warn(`[PipelineB:runScenario] runE2eScenario 失败: ${result.errorMessage}`)
  }

  // persist 到永久目录（pass / fail 都保留 evidence）。
  // persist 失败不让整个 graph crash —— 比如 evidence root 路径不可写时，
  // scenario run 仍应正确终结（result='error' / 'fail' 等），不传染上层。
  let evidenceDirUri: string | null = null
  try {
    const persisted = await persistEvidenceDir({
      tempDir: evidenceTempDir,
      runId,
      scenarioId: currentScenario.id,
      attemptNumber,
    })
    evidenceDirUri = persisted.evidenceDirUri
  } catch (err) {
    console.warn(
      `[PipelineB:runScenario] persistEvidenceDir 失败 runId=${runId} scenario=${currentScenario.id} attempt=${attemptNumber}:`,
      err,
    )
  }

  // manifest 直写 e2e_scenario_runs.evidence_manifest（pass/fail 路径都写）。
  // host Claude 跑挂没产出 manifest 时，把 errorMessage 落到 evidence_manifest.scenarioRunnerError，
  // 否则 DB 字段是 NULL，前端「查看证据」drawer 只能干瞪眼，看不到为何 fail。
  const manifestForDb: Record<string, unknown> | undefined = result.manifest
    ? (result.manifest as unknown as Record<string, unknown>)
    : result.errorMessage
      ? { scenarioRunnerError: result.errorMessage }
      : undefined
  await finishScenarioRun(scenarioRunRecord.id, scenarioResult, {
    durationMs: result.manifest?.durationMs,
    evidenceDirUri: evidenceDirUri ?? undefined,
    evidenceManifest: manifestForDb,
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
    evidenceDirTemp: evidenceDirUri, // 用 URI 而不是 temp dir（已 persist），collect-evidence 节点用得到
    currentManifest: result.manifest,
    governorState: newGovernorState,
  }
}
