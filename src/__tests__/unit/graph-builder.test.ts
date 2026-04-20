import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { MemorySaver, Command } from '@langchain/langgraph'
import {
  buildGraphFromStages,
  type StageHooks,
  type BuildGraphInput,
} from '../../pipeline/graph-builder.js'
import type {
  StageDefinition,
  StageExecutionResult,
  ServerInfo,
  StageContext,
} from '../../pipeline/types.js'

// Helpers -----------------------------------------------------------------

function makeStage(partial: Partial<StageDefinition> & Pick<StageDefinition, 'name' | 'stageType'>): StageDefinition {
  return {
    targetRoles: [],
    parallel: false,
    timeoutSeconds: 60,
    retryCount: 0,
    onFailure: 'stop',
    ...partial,
  }
}

const server1: ServerInfo = {
  id: 1,
  host: '10.0.0.1',
  port: 22,
  username: 'ops',
  password: 'x',
  role: 'app',
}

function baseCtx(overrides: Partial<Omit<StageContext, 'stageIndex'>> = {}) {
  return {
    runId: 42,
    servers: { app: [server1] } as Record<string, ServerInfo[]>,
    logDir: '/tmp/chatops-test',
    ...overrides,
  }
}

function okHooks(): StageHooks {
  return {
    async runScript(): Promise<StageExecutionResult> {
      return { status: 'success', output: 'script ok' }
    },
    async runCapability(): Promise<StageExecutionResult> {
      return { status: 'success', output: 'cap ok' }
    },
  }
}

function compile(input: BuildGraphInput) {
  const g = buildGraphFromStages(input)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (g as any).compile({ checkpointer: new MemorySaver() })
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) {
    // drain
  }
}

// Tests --------------------------------------------------------------------

describe('buildGraphFromStages — linear all-success', () => {
  it('runs script → capability → approval(approved) → wait_webhook(data)', async () => {
    const stages: StageDefinition[] = [
      makeStage({ name: 's1-script', stageType: 'script', targetRoles: ['app'] }),
      makeStage({ name: 's2-cap', stageType: 'capability', capabilityKey: 'build' }),
      makeStage({
        name: 's3-approval',
        stageType: 'approval',
        approverIds: ['u1'],
        approvalDescription: '上线审批',
      }),
      makeStage({ name: 's4-webhook', stageType: 'wait_webhook', webhookTag: 'deploy' }),
    ]

    const graph = compile({ stages, stageContext: baseCtx(), hooks: okHooks() })
    const config = { configurable: { thread_id: randomUUID() } }

    // First stream: runs until approval interrupt.
    await drain(await graph.stream({ runId: 42 }, config))
    let snap = await graph.getState(config)
    expect(snap.values.stageResults.map((r: { status: string }) => r.status)).toEqual([
      'success',
      'success',
    ])

    // Resume approval with approved — stops at webhook interrupt.
    await drain(await graph.stream(new Command({ resume: 'approved' }), config))
    snap = await graph.getState(config)
    expect(snap.values.stageResults.map((r: { status: string }) => r.status)).toEqual([
      'success',
      'success',
      'success',
    ])

    // Resume webhook with structured data — pipeline finishes.
    await drain(
      await graph.stream(
        new Command({ resume: { data: { buildId: '42', commit: 'abc' } } }),
        config,
      ),
    )
    const final = await graph.getState(config)
    const statuses = final.values.stageResults.map((r: { status: string }) => r.status)
    expect(statuses).toEqual(['success', 'success', 'success', 'success'])
    expect(final.values.runtimeVars.buildId).toBe('42')
    expect(final.values.runtimeVars.commit).toBe('abc')
  })
})

describe('buildGraphFromStages — onFailure=stop skips downstream', () => {
  it('second stage fails with stop → remaining stages marked skipped', async () => {
    const stages: StageDefinition[] = [
      makeStage({ name: 's1', stageType: 'script', targetRoles: ['app'] }),
      makeStage({ name: 's2', stageType: 'script', targetRoles: ['app'], onFailure: 'stop' }),
      makeStage({ name: 's3', stageType: 'script', targetRoles: ['app'] }),
      makeStage({ name: 's4', stageType: 'capability', capabilityKey: 'notify' }),
    ]

    let call = 0
    const hooks: StageHooks = {
      async runScript() {
        call += 1
        if (call === 2) return { status: 'failed', output: 'boom', error: 'boom' }
        return { status: 'success', output: 'ok' }
      },
      async runCapability() {
        return { status: 'success', output: 'cap' }
      },
    }

    const graph = compile({ stages, stageContext: baseCtx(), hooks })
    const config = { configurable: { thread_id: randomUUID() } }
    await drain(await graph.stream({ runId: 42 }, config))
    const snap = await graph.getState(config)
    const byName = Object.fromEntries(
      snap.values.stageResults.map((r: { name: string; status: string }) => [r.name, r.status]),
    )
    expect(byName.s1).toBe('success')
    expect(byName.s2).toBe('failed')
    expect(byName.s3).toBe('skipped')
    expect(byName.s4).toBe('skipped')
  })
})

describe('buildGraphFromStages — onFailure=continue keeps going', () => {
  it('capability fails but continue → downstream still executes', async () => {
    const stages: StageDefinition[] = [
      makeStage({ name: 's1', stageType: 'script', targetRoles: ['app'] }),
      makeStage({
        name: 's2-cap',
        stageType: 'capability',
        capabilityKey: 'flaky',
        onFailure: 'continue',
      }),
      makeStage({ name: 's3', stageType: 'script', targetRoles: ['app'] }),
    ]

    const hooks: StageHooks = {
      async runScript() {
        return { status: 'success', output: 'ok' }
      },
      async runCapability() {
        return { status: 'failed', output: 'cap down', error: 'boom' }
      },
    }

    const graph = compile({ stages, stageContext: baseCtx(), hooks })
    const config = { configurable: { thread_id: randomUUID() } }
    await drain(await graph.stream({ runId: 42 }, config))
    const snap = await graph.getState(config)
    const statuses = snap.values.stageResults.map((r: { status: string }) => r.status)
    expect(statuses).toEqual(['success', 'failed', 'success'])
  })
})

describe('buildGraphFromStages — hook throw is caught', () => {
  it('script hook throws + onFailure=continue → stage failed, downstream runs', async () => {
    const stages: StageDefinition[] = [
      makeStage({ name: 's1', stageType: 'script', targetRoles: ['app'] }),
      makeStage({
        name: 's2-throws',
        stageType: 'script',
        targetRoles: ['app'],
        onFailure: 'continue',
      }),
      makeStage({ name: 's3', stageType: 'script', targetRoles: ['app'] }),
    ]

    let call = 0
    const hooks: StageHooks = {
      async runScript() {
        call += 1
        if (call === 2) throw new Error('hook blew up')
        return { status: 'success', output: 'ok' }
      },
      async runCapability() {
        return { status: 'success', output: '' }
      },
    }

    const graph = compile({ stages, stageContext: baseCtx(), hooks })
    const config = { configurable: { thread_id: randomUUID() } }
    await drain(await graph.stream({ runId: 42 }, config))
    const snap = await graph.getState(config)
    const byName = Object.fromEntries(
      snap.values.stageResults.map(
        (r: { name: string; status: string; error?: string }) => [r.name, r],
      ),
    )
    expect((byName.s1 as { status: string }).status).toBe('success')
    const s2 = byName['s2-throws'] as { status: string; error?: string }
    expect(s2.status).toBe('failed')
    expect(s2.error).toContain('hook blew up')
    expect((byName.s3 as { status: string }).status).toBe('success')
  })
})

describe('buildGraphFromStages — approval rejected', () => {
  it('resume("rejected") → status failed + downstream skipped (onFailure=stop)', async () => {
    const stages: StageDefinition[] = [
      makeStage({ name: 'approve', stageType: 'approval', approverIds: ['u1'], onFailure: 'stop' }),
      makeStage({ name: 'deploy', stageType: 'script', targetRoles: ['app'] }),
    ]

    const graph = compile({ stages, stageContext: baseCtx(), hooks: okHooks() })
    const config = { configurable: { thread_id: randomUUID() } }
    await drain(await graph.stream({ runId: 42 }, config))
    await drain(await graph.stream(new Command({ resume: 'rejected' }), config))
    const snap = await graph.getState(config)
    const byName = Object.fromEntries(
      snap.values.stageResults.map((r: { name: string; status: string; error?: string }) => [
        r.name,
        r,
      ]),
    )
    expect((byName.approve as { status: string }).status).toBe('failed')
    expect((byName.approve as { error?: string }).error).toBe('rejected')
    expect((byName.deploy as { status: string }).status).toBe('skipped')
  })
})

describe('buildGraphFromStages — wait_webhook timeout', () => {
  it('resume({timeout:true}) → status failed, error=timeout', async () => {
    const stages: StageDefinition[] = [
      makeStage({ name: 'wait', stageType: 'wait_webhook', webhookTag: 'deploy' }),
    ]
    const graph = compile({ stages, stageContext: baseCtx(), hooks: okHooks() })
    const config = { configurable: { thread_id: randomUUID() } }
    await drain(await graph.stream({ runId: 42 }, config))
    await drain(await graph.stream(new Command({ resume: { timeout: true } }), config))
    const snap = await graph.getState(config)
    const r = snap.values.stageResults[0] as { status: string; error?: string }
    expect(r.status).toBe('failed')
    expect(r.error).toBe('timeout')
  })
})

describe('buildGraphFromStages — script with no target servers', () => {
  it('targetRoles empty + serverMap empty → status=skipped', async () => {
    const stages: StageDefinition[] = [
      makeStage({ name: 'orphan', stageType: 'script' }),
    ]
    const ctx = baseCtx({ servers: {} })
    let called = false
    const hooks: StageHooks = {
      async runScript() {
        called = true
        return { status: 'success', output: 'should not run' }
      },
      async runCapability() {
        return { status: 'success', output: '' }
      },
    }
    const graph = compile({ stages, stageContext: ctx, hooks })
    const config = { configurable: { thread_id: randomUUID() } }
    await drain(await graph.stream({ runId: 42 }, config))
    const snap = await graph.getState(config)
    expect(snap.values.stageResults[0].status).toBe('skipped')
    expect(called).toBe(false)
  })
})
