// src/e2e/pipeline-b/runner.ts
import { buildPipelineBGraph } from './graph.js'
import { teardownSandboxNode } from './nodes/teardown-sandbox.js'
import { updateE2eRunStatus, countQueuedE2eRuns } from '../../db/repositories/e2e-runs.js'
import type { PipelineBStateType, GovernorState } from './types.js'

const MAX_QUEUED_RUNS = 2
const DEFAULT_GOVERNOR_LIMITS = {
  maxPerScenarioAttempts: 3,
  maxRunHours: 4,
  maxTotalAttempts: 30,
  maxQueuedRuns: MAX_QUEUED_RUNS,
}

export interface RunPipelineBOptions {
  targetProjectId: string
  sourceBranch: string
  scenarioFilter?: { ids?: string[]; tags?: string[] }
  triggerType: 'manual' | 'api' | 'scheduled' | 'im'
  triggerActor?: string
  governorOverrides?: {
    maxPerScenarioAttempts?: number
    maxRunHours?: number
    maxTotalAttempts?: number
  }
}

export async function runPipelineB(opts: RunPipelineBOptions): Promise<{ runId: bigint; status: string }> {
  const queuedCount = await countQueuedE2eRuns(opts.targetProjectId)
  if (queuedCount >= MAX_QUEUED_RUNS) {
    throw new Error(
      `当前已有 ${queuedCount} 个 run 在等待，请稍后再试或 abort 现有 run（上限 ${MAX_QUEUED_RUNS}）`
    )
  }

  const limits = {
    ...DEFAULT_GOVERNOR_LIMITS,
    ...opts.governorOverrides,
  }

  const governorState: GovernorState = {
    runStartedAt: Date.now(),
    totalAttempts: 0,
    totalElapsedMs: 0,
    perScenarioAttempts: {},
    limits,
  }

  const initialState: Partial<PipelineBStateType> = {
    runId: 0n,
    sandboxId: null,
    targetProjectId: opts.targetProjectId,
    sourceBranch: opts.sourceBranch,
    iterationBranch: '',
    sandboxHandle: null,
    pendingScenarios: [],
    currentScenario: null,
    currentScenarioRunId: null,
    lastScenarioResult: null,
    lastFixResult: null,
    evidenceDirTemp: null,
    governorState,
    summaryMrUrl: null,
    errorMessage: null,
    projectScripts: { build: 'build.sh', deploy: 'deploy.sh', test: 'test.sh' },
    scenarioFilter: opts.scenarioFilter ?? null,
  }

  const graph = buildPipelineBGraph()
  let lastKnownState: Partial<PipelineBStateType> = initialState
  let finalStatus = 'aborted'

  try {
    const result = await graph.invoke(initialState, { recursionLimit: 500 }) as PipelineBStateType
    lastKnownState = result
    const pending = result.pendingScenarios ?? []
    finalStatus = pending.length === 0 ? 'passed' : 'failed'
    return { runId: result.runId, status: finalStatus }
  } catch (err) {
    const runId = (lastKnownState as PipelineBStateType).runId
    if (runId) {
      await updateE2eRunStatus(runId, 'aborted', { abortReason: String(err) }).catch(() => undefined)
    }
    await teardownSandboxNode(lastKnownState as PipelineBStateType).catch(() => undefined)
    throw err
  }
}
