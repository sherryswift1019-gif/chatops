/**
 * graph-runner — unit tests for the compile+stream+interrupt runtime.
 *
 * These tests mock the DB layer and the checkpointer to isolate the
 * runner's behaviour from Postgres. The real graph-builder is exercised so
 * we validate the full interrupt dispatch path.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { MemorySaver } from '@langchain/langgraph'

// --- Mocks (must be hoisted before the graph-runner import) ----------------

// vi.hoisted 让 factory 之间共享同一份 in-memory map（factory 在 module load 前执行,
// 不能闭包外部变量；vi.hoisted 是官方 escape hatch）。stage-status 路径和
// test-runs 路径都要看到同一个 latest，否则 finalize() 读不到 stage-status 写过的
// stageResults，summarizeStatus 会误判为 success。
const sharedStore = vi.hoisted(() => ({
  latest: new Map<number, Array<Record<string, unknown>>>(),
  updateTestRunStageCalls: [] as Array<{
    id: number
    currentStage: number
    stageResults: Array<Record<string, unknown>>
  }>,
}))

// In-memory stores so tests can inspect what the runner persisted.
const updateTestRunStageCalls = sharedStore.updateTestRunStageCalls
const finishTestRunCalls: Array<{
  id: number
  status: string
  reportPath: string
  errorMessage: string
}> = []
const bulkSetCalls: Array<{ ids: number[]; status: string }> = []

vi.mock('../../pipeline/graph-runtime.js', async () => {
  const memorySaver = new MemorySaver()
  return {
    getCheckpointer: async () => memorySaver,
    resetCheckpointerForTesting: () => {},
  }
})

// stage-status race-fix 后通过 getPool() 直连 DB，绕过 test-runs repo。
// 单测里 mock 它，把写入路由到 sharedStore.latest，保持 finalize 路径可观察。
vi.mock('../../pipeline/stage-status.js', async () => {
  // mergeStageResults 需要从真模块拿；不能 mock graph-state。
  const { mergeStageResults } = await import('../../pipeline/graph-state.js')
  return {
    markStageRunning: vi.fn(
      async (
        runId: number,
        stage: { name: string; stageType?: string; type?: string },
        startedAtIso: string,
      ) => {
        const existing = sharedStore.latest.get(runId) ?? []
        const FINALIZED = new Set(['success', 'failed', 'skipped'])
        const prior = existing.find((r) => r.name === stage.name)
        if (prior && FINALIZED.has(prior.status as string)) return
        if (prior && prior.status === 'running') return
        const entry = {
          name: stage.name,
          type: stage.stageType ?? stage.type ?? 'unknown',
          status: 'running',
          startedAt: startedAtIso,
        }
        const merged = mergeStageResults(existing as never, entry as never)
        sharedStore.latest.set(runId, JSON.parse(JSON.stringify(merged)))
        sharedStore.updateTestRunStageCalls.push({
          id: runId,
          currentStage: 0,
          stageResults: JSON.parse(JSON.stringify(merged)),
        })
      },
    ),
    mergeAndPersistStageResults: vi.fn(
      async (
        runId: number,
        currentStage: number,
        stateStageResults: Array<Record<string, unknown>>,
      ) => {
        const existing = sharedStore.latest.get(runId) ?? []
        const merged = mergeStageResults(
          existing as never,
          stateStageResults as never,
        )
        sharedStore.latest.set(runId, JSON.parse(JSON.stringify(merged)))
        sharedStore.updateTestRunStageCalls.push({
          id: runId,
          currentStage,
          stageResults: JSON.parse(JSON.stringify(merged)),
        })
      },
    ),
    mergeAiAnalysisIntoStage: vi.fn(
      async (runId: number, stageName: string, aiAnalysis: string) => {
        const existing = sharedStore.latest.get(runId) ?? []
        const next = existing.slice()
        const idx = next.findIndex((r) => r.name === stageName)
        if (idx < 0) return
        if ((next[idx] as { aiAnalysis?: string }).aiAnalysis) return
        next[idx] = { ...next[idx], aiAnalysis }
        sharedStore.latest.set(runId, JSON.parse(JSON.stringify(next)))
      },
    ),
  }
})

vi.mock('../../db/repositories/test-runs.js', () => {
  return {
    getTestRunById: vi.fn(async (id: number) => ({
      id,
      pipelineId: 100,
      triggerType: 'manual',
      triggeredBy: 'alice',
      status: 'running',
      servers: { app: ['10.0.0.1'] },
      currentStage: 0,
      stageResults: sharedStore.latest.get(id) ?? [],
      reportPath: '',
      startedAt: new Date('2026-01-01T00:00:00Z'),
      finishedAt: null,
      errorMessage: '',
      createdAt: new Date(),
      runtimeVars: {},
    })),
    updateTestRunStage: vi.fn(
      async (
        id: number,
        currentStage: number,
        stageResults: Array<Record<string, unknown>>,
      ) => {
        sharedStore.latest.set(id, JSON.parse(JSON.stringify(stageResults)))
        sharedStore.updateTestRunStageCalls.push({
          id,
          currentStage,
          stageResults: JSON.parse(JSON.stringify(stageResults)),
        })
      },
    ),
    finishTestRun: vi.fn(async (id: number, status: string, reportPath: string, errorMessage = '') => {
      finishTestRunCalls.push({ id, status, reportPath, errorMessage })
    }),
  }
})

vi.mock('../../db/repositories/test-pipelines.js', () => ({
  getTestPipelineById: vi.fn(async (id: number) => ({
    id,
    productLineId: 1,
    name: 'pipeline-for-tests',
    description: '',
    stages: [
      {
        name: 'deploy',
        stageType: 'script',
        targetRoles: ['app'],
        parallel: false,
        timeoutSeconds: 60,
        retryCount: 0,
        onFailure: 'stop',
      },
    ],
    serverRoles: {},
    schedule: '',
    enabled: true,
    triggerParams: {},
    variables: {},
    artifactInputs: [],
    graph: null,
    containerImage: null,
    paramSchema: null,
    imPrompt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  })),
}))

vi.mock('../../db/repositories/product-lines.js', () => ({
  getProductLineById: vi.fn(async () => ({
    id: 1,
    name: 'paraview',
    displayName: 'ParaView',
  })),
}))

vi.mock('../../db/repositories/test-servers.js', () => ({
  listTestServers: vi.fn(async () => [
    { id: 1, host: '10.0.0.1', port: 22, username: 'ops', credential: 'x', role: 'app', name: 'host-1' },
  ]),
  bulkSetServerStatus: vi.fn(async (ids: number[], status: string) => {
    bulkSetCalls.push({ ids, status })
  }),
}))

vi.mock('../../db/repositories/dingtalk-users.js', () => ({
  getDingTalkUserById: vi.fn(async () => null),
}))

vi.mock('../../pipeline/report-generator.js', () => ({
  generateHtmlReport: vi.fn(async () => '/tmp/report.html'),
  generateZipArchive: vi.fn(async () => '/tmp/archive.zip'),
}))

vi.mock('../../pipeline/failure-analyzer.js', () => ({
  analyzeFailure: vi.fn(async () => 'analysis stub'),
}))

// Capture the cards that the approval-manager "sent" so tests can assert on
// them without needing a real IM adapter.
const requestCardCalls: Array<{
  runId: number
  stageIndex: number
  approverIds: string[]
  description: string
}> = []
const mockApprovalSetResumeHandler = vi.fn()
const mockWaiterRegister = vi.fn()
const mockWaiterSetResumeHandler = vi.fn()

vi.mock('../../pipeline/approval-manager.js', () => {
  return {
    PipelineApprovalManager: {
      getInstance: () => ({
        requestCard: vi.fn(async (params: {
          runId: number
          stageIndex: number
          approverIds: string[]
          description: string
        }) => {
          requestCardCalls.push(params)
          return 'approval-id-stub'
        }),
        setResumeHandler: mockApprovalSetResumeHandler,
        isPipelineApproval: () => false,
        handleCallback: vi.fn(),
      }),
    },
  }
})

vi.mock('../../pipeline/webhook-waiter.js', () => {
  return {
    WebhookWaiter: {
      getInstance: () => ({
        register: mockWaiterRegister,
        setResumeHandler: mockWaiterSetResumeHandler,
        resume: () => true,
        pendingCount: 0,
      }),
    },
  }
})

// --- Test subject import (deferred so mocks are in place) -------------------

import {
  startRun,
  resumeRun,
  registerRunMeta,
  purgeRunMeta,
  getRegistrySize,
  initGraphRunnerDispatchers,
} from '../../pipeline/graph-runner.js'
import { Command } from '@langchain/langgraph'
import type { StageHooks, StageContextBase } from '../../pipeline/graph-builder.js'
import type { StageDefinition, ServerInfo, StageExecutionResult } from '../../pipeline/types.js'

// --- Helpers ----------------------------------------------------------------

const server1: ServerInfo = {
  id: 1,
  host: '10.0.0.1',
  port: 22,
  username: 'ops',
  password: 'x',
  role: 'app',
}

function makeStage(
  partial: Partial<StageDefinition> & Pick<StageDefinition, 'name' | 'stageType'>,
): StageDefinition {
  return {
    targetRoles: [],
    parallel: false,
    timeoutSeconds: 60,
    retryCount: 0,
    onFailure: 'stop',
    ...partial,
  }
}

function baseCtx(runId = 42): StageContextBase {
  return {
    runId,
    servers: { app: [server1] },
    logDir: '/tmp/chatops-graph-runner-test',
    productLine: { name: 'pl', displayName: 'PL' },
    pipeline: { id: 100, name: 'pipeline-for-tests' },
    run: { id: runId, triggeredBy: 'alice', triggerType: 'manual' },
    variables: {},
  }
}

function okHooks(): StageHooks {
  return {
    async runScript(): Promise<StageExecutionResult> {
      return { status: 'success', output: 'ok' }
    },
    async runCapability(): Promise<StageExecutionResult> {
      return { status: 'success', output: 'ok' }
    },
  }
}

function registerMinimalMeta(runId: number) {
  registerRunMeta({
    runId,
    pipelineId: 100,
    pipelineName: 'pipeline-for-tests',
    triggerType: 'manual',
    triggeredBy: 'alice',
    serverAssignment: { app: ['10.0.0.1'] },
    serverIds: [1],
    logDir: '/tmp/chatops-graph-runner-test',
    startedAt: new Date('2026-01-01T00:00:00Z'),
    pipelineStartMs: Date.now(),
  })
}

/** Patch the pipeline-by-id mock for the next resumeRun call (once). */
async function mockPipelineStagesOnce(stages: StageDefinition[]) {
  const { getTestPipelineById } = await import('../../db/repositories/test-pipelines.js')
  vi.mocked(getTestPipelineById).mockResolvedValueOnce({
    id: 100,
    productLineId: 1,
    name: 'pipeline-for-tests',
    description: '',
    stages,
    serverRoles: {},
    enabled: true,
    triggerParams: {},
    variables: {},
    artifactInputs: [],
    graph: null,
    containerImage: null,
    paramSchema: null,
    imPrompt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  })
}

beforeEach(() => {
  updateTestRunStageCalls.length = 0
  finishTestRunCalls.length = 0
  bulkSetCalls.length = 0
  requestCardCalls.length = 0
  sharedStore.latest.clear()
  mockApprovalSetResumeHandler.mockClear()
  mockWaiterRegister.mockClear()
  mockWaiterSetResumeHandler.mockClear()
})

// --- Tests ------------------------------------------------------------------

describe('graph-runner — linear script stages', () => {
  it('startRun with 2 script stages → updates stage + finalizes success', async () => {
    const runId = 101
    const stages: StageDefinition[] = [
      makeStage({ name: 'step1', stageType: 'script', targetRoles: ['app'] }),
      makeStage({ name: 'step2', stageType: 'script', targetRoles: ['app'] }),
    ]
    registerMinimalMeta(runId)
    const sizeBefore = getRegistrySize()

    await startRun({
      runId,
      pipelineId: 100,
      stages,
      stageContext: baseCtx(runId),
      hooks: okHooks(),
      triggerParams: {},
    })

    // At least one stage update per stage completion.
    expect(updateTestRunStageCalls.length).toBeGreaterThanOrEqual(2)
    // finishTestRun called with success.
    expect(finishTestRunCalls).toHaveLength(1)
    expect(finishTestRunCalls[0].id).toBe(runId)
    expect(finishTestRunCalls[0].status).toBe('success')
    // Server lock released.
    expect(bulkSetCalls.some((c) => c.status === 'idle')).toBe(true)
    // Registry cleaned up — finalize() must drop the meta.
    expect(getRegistrySize()).toBe(sizeBefore - 1)
  })
})

describe('graph-runner — registry lifecycle', () => {
  it('purgeRunMeta removes the run and does not run finalize', async () => {
    const runId = 150
    registerMinimalMeta(runId)
    const sizeBefore = getRegistrySize()
    expect(sizeBefore).toBeGreaterThanOrEqual(1)

    purgeRunMeta(runId)

    expect(getRegistrySize()).toBe(sizeBefore - 1)
    // purgeRunMeta must NOT run the finalize pipeline — it's a caller-side
    // escape hatch for the case where the graph never even started.
    expect(finishTestRunCalls).toHaveLength(0)
    expect(bulkSetCalls).toHaveLength(0)
  })
})

describe('graph-runner — approval interrupt dispatch', () => {
  it('startRun pauses at approval → requestCard called with correct payload', async () => {
    const runId = 202
    const stages: StageDefinition[] = [
      makeStage({
        name: 'gate',
        stageType: 'approval',
        approverIds: ['alice'],
        approvalDescription: '发布上线',
      }),
      makeStage({ name: 'deploy', stageType: 'script', targetRoles: ['app'] }),
    ]
    registerMinimalMeta(runId)

    await startRun({
      runId,
      pipelineId: 100,
      stages,
      stageContext: baseCtx(runId),
      hooks: okHooks(),
      triggerParams: {},
    })

    // Approval adapter consulted exactly once.
    expect(requestCardCalls).toHaveLength(1)
    expect(requestCardCalls[0]).toMatchObject({
      runId,
      stageIndex: 0,
      approverIds: ['alice'],
      description: '发布上线',
    })
    // finishTestRun NOT called yet — graph is paused.
    expect(finishTestRunCalls).toHaveLength(0)
  })

  it('approval resume("approved") drives the graph forward to completion', async () => {
    const runId = 203
    const stages: StageDefinition[] = [
      makeStage({
        name: 'gate',
        stageType: 'approval',
        approverIds: ['alice'],
        approvalDescription: '发布上线',
      }),
      makeStage({ name: 'deploy', stageType: 'script', targetRoles: ['app'] }),
    ]
    registerMinimalMeta(runId)

    await startRun({
      runId,
      pipelineId: 100,
      stages,
      stageContext: baseCtx(runId),
      hooks: okHooks(),
      triggerParams: {},
    })
    expect(finishTestRunCalls).toHaveLength(0)

    await mockPipelineStagesOnce(stages)
    await resumeRun(runId, new Command({ resume: 'approved' }))
    expect(finishTestRunCalls).toHaveLength(1)
    expect(finishTestRunCalls[0].status).toBe('success')
  })
})

describe('graph-runner — webhook interrupt dispatch', () => {
  it('startRun pauses at wait_webhook → waiter.register called', async () => {
    const runId = 303
    const stages: StageDefinition[] = [
      makeStage({ name: 'wait', stageType: 'wait_webhook', webhookTag: 'deploy:ok' }),
    ]
    registerMinimalMeta(runId)

    await startRun({
      runId,
      pipelineId: 100,
      stages,
      stageContext: baseCtx(runId),
      hooks: okHooks(),
      triggerParams: {},
    })

    expect(mockWaiterRegister).toHaveBeenCalledTimes(1)
    expect(mockWaiterRegister.mock.calls[0][0]).toBe('deploy:ok')
    expect(mockWaiterRegister.mock.calls[0][1]).toBe(runId)
    expect(mockWaiterRegister.mock.calls[0][2]).toBe(0)
    // Not finalized yet.
    expect(finishTestRunCalls).toHaveLength(0)
  })
})

describe('graph-runner — initGraphRunnerDispatchers', () => {
  it('wires resume handlers onto approval-manager and webhook-waiter', () => {
    initGraphRunnerDispatchers()
    expect(mockApprovalSetResumeHandler).toHaveBeenCalledTimes(1)
    expect(mockWaiterSetResumeHandler).toHaveBeenCalledTimes(1)
    expect(typeof mockApprovalSetResumeHandler.mock.calls[0][0]).toBe('function')
    expect(typeof mockWaiterSetResumeHandler.mock.calls[0][0]).toBe('function')
  })
})

describe('graph-runner — approval timeout', () => {
  it('resuming with "timeout" marks the stage failed and finalizes', async () => {
    const runId = 404
    const stages: StageDefinition[] = [
      makeStage({
        name: 'gate',
        stageType: 'approval',
        approverIds: ['alice'],
        onFailure: 'stop',
        timeoutSeconds: 1,
      }),
      makeStage({ name: 'deploy', stageType: 'script', targetRoles: ['app'] }),
    ]
    registerMinimalMeta(runId)

    await startRun({
      runId,
      pipelineId: 100,
      stages,
      stageContext: baseCtx(runId),
      hooks: okHooks(),
      triggerParams: {},
    })
    expect(finishTestRunCalls).toHaveLength(0)

    await mockPipelineStagesOnce(stages)
    await resumeRun(runId, new Command({ resume: 'timeout' }))

    expect(finishTestRunCalls).toHaveLength(1)
    expect(finishTestRunCalls[0].status).toBe('failed')
  })
})

describe('graph-runner — webhook timeout', () => {
  it('resuming webhook with { timeout: true } finalizes failed', async () => {
    const runId = 505
    const stages: StageDefinition[] = [
      makeStage({ name: 'wait', stageType: 'wait_webhook', webhookTag: 'deploy' }),
    ]
    registerMinimalMeta(runId)

    await startRun({
      runId,
      pipelineId: 100,
      stages,
      stageContext: baseCtx(runId),
      hooks: okHooks(),
      triggerParams: {},
    })

    await mockPipelineStagesOnce(stages)
    await resumeRun(runId, new Command({ resume: { timeout: true } }))

    expect(finishTestRunCalls).toHaveLength(1)
    expect(finishTestRunCalls[0].status).toBe('failed')
  })
})

describe('graph-runner — resumeRun with missing run', () => {
  it('does nothing when pipeline/run not found', async () => {
    const { getTestRunById } = await import('../../db/repositories/test-runs.js')
    vi.mocked(getTestRunById).mockResolvedValueOnce(null)

    await resumeRun(9999, new Command({ resume: 'approved' }))
    // No finalize — silently dropped.
    expect(finishTestRunCalls).toHaveLength(0)
  })
})
