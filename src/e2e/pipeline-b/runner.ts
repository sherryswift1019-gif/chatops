// src/e2e/pipeline-b/runner.ts
import { buildPipelineBGraph } from './graph.js'
import { teardownSandboxNode } from './nodes/teardown-sandbox.js'
import {
  getE2eRun,
  updateE2eRunStatus,
  updateE2eRunGovernorState,
  countQueuedE2eRuns,
} from '../../db/repositories/e2e-runs.js'
import { buildInitialGovernorState, DEFAULT_GOVERNOR_LIMITS } from './governor.js'
import type { PipelineBStateType, ImContext } from './types.js'
import { notifyRunAborted } from './im-notifier.js'

const MAX_QUEUED_RUNS = DEFAULT_GOVERNOR_LIMITS.maxQueuedRuns

// Terminal statuses 不应被 catch 路径覆盖（节点已经做出最终决定）
const TERMINAL_STATUSES = new Set(['passed', 'failed', 'aborted'])

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
  existingRunId?: bigint
  imContext?: ImContext
}

export async function runPipelineB(opts: RunPipelineBOptions): Promise<{ runId: bigint; status: string }> {
  const queuedCount = await countQueuedE2eRuns(opts.targetProjectId)
  if (queuedCount >= MAX_QUEUED_RUNS) {
    throw new Error(
      `当前已有 ${queuedCount} 个 run 在等待，请稍后再试或 abort 现有 run（上限 ${MAX_QUEUED_RUNS}）`
    )
  }

  const governorState = buildInitialGovernorState(opts.governorOverrides)

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
    ...(opts.existingRunId ? { runId: opts.existingRunId } : {}),
    imContext: opts.imContext ?? null,
  }

  const graph = buildPipelineBGraph()
  let lastKnownState: Partial<PipelineBStateType> = initialState
  let finalStatus = 'aborted'

  try {
    const result = await graph.invoke(initialState, { recursionLimit: 500 }) as PipelineBStateType
    lastKnownState = result
    const pending = result.pendingScenarios ?? []
    finalStatus = pending.length === 0 ? 'passed' : 'failed'
    // 把最终内存版本 governorState（含真实 counters）写回 DB，让详情页反映 run 结束时的进度。
    // status 已由内层节点（finalize-failed / create-summary-mr）写入，此处只更新 governorState。
    if (result.runId) {
      await updateE2eRunGovernorState(
        result.runId,
        result.governorState as unknown as Record<string, unknown>,
      ).catch((e) => console.warn('[runner] persist governorState failed:', e))
    }
    return { runId: result.runId, status: finalStatus }
  } catch (err) {
    const runId = (lastKnownState as PipelineBStateType).runId
    const finalGovernor = (lastKnownState as PipelineBStateType).governorState
    if (runId) {
      // 如果某个节点已经写了 terminal status（比如 createSummaryMr 写 'passed'，
      // 之后 teardown 抛错），catch 路径不应把 status 倒退成 'aborted'。
      // 只补 abortReason / governorState 让事故可见，不动 status。
      const existing = await getE2eRun(runId).catch(() => null)
      const alreadyTerminal = existing && TERMINAL_STATUSES.has(existing.status)
      const targetStatus = alreadyTerminal ? existing.status : 'aborted'
      await updateE2eRunStatus(runId, targetStatus, {
        abortReason: String(err),
        governorState: finalGovernor as unknown as Record<string, unknown>,
      }).catch(() => undefined)
    }
    await teardownSandboxNode(lastKnownState as PipelineBStateType).catch(() => undefined)
    if (opts.imContext) {
      const runIdForNotify = (lastKnownState as PipelineBStateType).runId
      const msg = err instanceof Error ? err.message : String(err)
      notifyRunAborted(
        { adapter: opts.imContext.adapter, groupId: opts.imContext.groupId, runId: runIdForNotify },
        msg,
      ).catch(() => {})
    }
    throw err
  }
}
