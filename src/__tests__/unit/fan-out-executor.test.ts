import { describe, it, expect } from 'vitest'
import type { ExecutionContext, NodeExecutor } from '../../pipeline/node-types/types.js'
// Ensure all referenced executors are registered (template_render is used as a no-side-effect body node)
import '../../pipeline/node-types/template-render.js'
import '../../pipeline/node-types/fan-out.js'
import { getExecutor, registerNodeType } from '../../pipeline/node-types/registry.js'

function makeCtx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    runId: 1,
    pipelineId: 100,
    nodeId: 'fanout1',
    triggerParams: {},
    vars: {},
    steps: {},
    ...overrides,
  }
}

function loadFanOutExecutor() {
  const exec = getExecutor('fan_out')
  if (!exec) throw new Error('fan_out executor not registered')
  return exec
}

// --- Helper bodies registered once for tests; using unique keys to avoid collision ---

let helperRegistered = false
function ensureTestHelpersRegistered(): void {
  if (helperRegistered) return
  helperRegistered = true

  // Echo body: returns its scope item under output.value (uses ctx.scopes injected by fan_out)
  registerNodeType({
    key: 'test_echo_scope',
    async execute(params, ctx) {
      const scopeKey = (params.scopeKey as string) ?? 'item'
      const value = ctx.scopes?.[scopeKey]
      return { status: 'success', output: { value } }
    },
  } as NodeExecutor)

  // Always-fail body
  registerNodeType({
    key: 'test_always_fail',
    async execute() {
      return { status: 'failed', output: {}, error: 'forced failure' }
    },
  } as NodeExecutor)

  // Conditional fail: fails iff scope.item.bad === true
  registerNodeType({
    key: 'test_fail_if_bad',
    async execute(_params, ctx) {
      const item = ctx.scopes?.item as Record<string, unknown> | undefined
      if (item && item.bad === true) {
        return { status: 'failed', output: {}, error: 'bad item' }
      }
      return { status: 'success', output: { ok: true, item } }
    },
  } as NodeExecutor)

  // Concurrency tracker: increments a shared counter and records max-observed
  // We expose the trackers via module-level Maps keyed by ctx.runId so tests can read them back.
  registerNodeType({
    key: 'test_track_concurrency',
    async execute(_params, ctx) {
      const tracker = concurrencyTrackers.get(ctx.runId)
      if (!tracker) return { status: 'success', output: {} }
      tracker.active++
      tracker.maxActive = Math.max(tracker.maxActive, tracker.active)
      // Yield long enough to allow batch siblings to overlap
      await new Promise((r) => setTimeout(r, 20))
      tracker.active--
      return { status: 'success', output: { tick: tracker.maxActive } }
    },
  } as NodeExecutor)
}

interface ConcurrencyTracker {
  active: number
  maxActive: number
}
const concurrencyTrackers = new Map<number, ConcurrencyTracker>()

describe('fan_out node executor (phase 3 T15)', () => {
  ensureTestHelpersRegistered()

  it('iterates over array from {{vars.items}} and invokes body once per item', async () => {
    const exec = loadFanOutExecutor()
    const result = await exec.execute(
      {
        source: '{{vars.items}}',
        as: 'item',
        body: [{ id: 'echo', nodeTypeKey: 'test_echo_scope', params: { scopeKey: 'item' } }],
      },
      makeCtx({ vars: { items: [1, 2, 3] as unknown as string } as unknown as Record<string, unknown> }),
    )
    expect(result.status).toBe('success')
    const output = result.output as Record<string, unknown>
    expect(output.failed).toEqual([])
    const items = output.items as Array<Record<string, unknown>>
    expect(items).toHaveLength(3)
    expect(items.map((i) => i.value)).toEqual([1, 2, 3])
  })

  it('resolves source via {{steps.x.output.rows}} dot path', async () => {
    const exec = loadFanOutExecutor()
    const result = await exec.execute(
      {
        source: '{{steps.q1.output.rows}}',
        as: 'item',
        body: [{ id: 'echo', nodeTypeKey: 'test_echo_scope', params: { scopeKey: 'item' } }],
      },
      makeCtx({
        steps: {
          q1: { status: 'success', output: { rows: [{ id: 'a' }, { id: 'b' }] } },
        },
      }),
    )
    expect(result.status).toBe('success')
    const items = (result.output as Record<string, unknown>).items as Array<Record<string, unknown>>
    expect(items.map((i) => (i.value as Record<string, unknown>).id)).toEqual(['a', 'b'])
  })

  it('parallel=2 with 3 items observes at most 2 concurrent body executions', async () => {
    const exec = loadFanOutExecutor()
    const tracker: ConcurrencyTracker = { active: 0, maxActive: 0 }
    const runId = 9001
    concurrencyTrackers.set(runId, tracker)
    try {
      const result = await exec.execute(
        {
          source: '{{vars.items}}',
          as: 'item',
          parallel: 2,
          body: [{ id: 'tick', nodeTypeKey: 'test_track_concurrency', params: {} }],
        },
        makeCtx({ runId, vars: { items: [1, 2, 3] as unknown as string } as unknown as Record<string, unknown> }),
      )
      expect(result.status).toBe('success')
      expect(tracker.maxActive).toBeLessThanOrEqual(2)
      expect(tracker.maxActive).toBeGreaterThanOrEqual(1)
      const items = (result.output as Record<string, unknown>).items as unknown[]
      expect(items).toHaveLength(3)
    } finally {
      concurrencyTrackers.delete(runId)
    }
  })

  it('onItemFailure=continue: failure recorded in failed[] but overall status=success', async () => {
    const exec = loadFanOutExecutor()
    const result = await exec.execute(
      {
        source: '{{vars.items}}',
        as: 'item',
        onItemFailure: 'continue',
        body: [{ id: 'maybe', nodeTypeKey: 'test_fail_if_bad', params: {} }],
      },
      makeCtx({
        vars: { items: [{ bad: false }, { bad: true }, { bad: false }] as unknown as string } as unknown as Record<string, unknown>,
      }),
    )
    expect(result.status).toBe('success')
    const output = result.output as Record<string, unknown>
    const items = output.items as unknown[]
    const failed = output.failed as Array<Record<string, unknown>>
    expect(items).toHaveLength(2)
    expect(failed).toHaveLength(1)
    expect(failed[0].index).toBe(1)
    expect(failed[0].error).toContain('bad item')
  })

  it('onItemFailure=stop: aborts after first failure, status=failed', async () => {
    const exec = loadFanOutExecutor()
    const result = await exec.execute(
      {
        source: '{{vars.items}}',
        as: 'item',
        parallel: 1,  // serial so we can predict abort point
        onItemFailure: 'stop',
        body: [{ id: 'maybe', nodeTypeKey: 'test_fail_if_bad', params: {} }],
      },
      makeCtx({
        vars: { items: [{ bad: false }, { bad: true }, { bad: false }] as unknown as string } as unknown as Record<string, unknown>,
      }),
    )
    expect(result.status).toBe('failed')
    const output = result.output as Record<string, unknown>
    const failed = output.failed as Array<Record<string, unknown>>
    expect(failed).toHaveLength(1)
    expect(failed[0].index).toBe(1)
    // Items processed before failure should appear in items[]
    const items = output.items as unknown[]
    expect(items).toHaveLength(1)
  })

  it('onItemFailure=aggregate: like continue, status=success even with failures', async () => {
    const exec = loadFanOutExecutor()
    const result = await exec.execute(
      {
        source: '{{vars.items}}',
        as: 'item',
        onItemFailure: 'aggregate',
        body: [{ id: 'maybe', nodeTypeKey: 'test_fail_if_bad', params: {} }],
      },
      makeCtx({
        vars: { items: [{ bad: true }, { bad: false }] as unknown as string } as unknown as Record<string, unknown>,
      }),
    )
    expect(result.status).toBe('success')
    const output = result.output as Record<string, unknown>
    expect((output.items as unknown[])).toHaveLength(1)
    expect((output.failed as unknown[])).toHaveLength(1)
  })

  it('unknown body executor key → all items fail with "unknown executor"', async () => {
    const exec = loadFanOutExecutor()
    const result = await exec.execute(
      {
        source: '{{vars.items}}',
        as: 'item',
        body: [{ id: 'bogus', nodeTypeKey: 'definitely_does_not_exist', params: {} }],
      },
      makeCtx({ vars: { items: [1, 2] as unknown as string } as unknown as Record<string, unknown> }),
    )
    // continue (default) → status='success' but items=[] and failed has 2 entries
    expect(result.status).toBe('success')
    const output = result.output as Record<string, unknown>
    expect((output.items as unknown[])).toHaveLength(0)
    const failed = output.failed as Array<Record<string, unknown>>
    expect(failed).toHaveLength(2)
    for (const f of failed) {
      expect(String(f.error)).toContain('unknown executor')
    }
  })

  it('source resolves to non-array → status=failed with helpful error', async () => {
    const exec = loadFanOutExecutor()
    const result = await exec.execute(
      {
        source: '{{vars.notArray}}',
        as: 'item',
        body: [{ id: 'echo', nodeTypeKey: 'test_echo_scope', params: { scopeKey: 'item' } }],
      },
      makeCtx({ vars: { notArray: 'just a string' } }),
    )
    expect(result.status).toBe('failed')
    expect(result.error).toContain('did not resolve to array')
  })

  it('rejects nested fan_out in body (v1 limit)', async () => {
    const exec = loadFanOutExecutor()
    const result = await exec.execute(
      {
        source: '{{vars.items}}',
        as: 'item',
        body: [{ id: 'inner', nodeTypeKey: 'fan_out', params: {} }],
      },
      makeCtx({ vars: { items: [1] as unknown as string } as unknown as Record<string, unknown> }),
    )
    expect(result.status).toBe('failed')
    expect(result.error).toContain('does not support nesting')
  })

  it('missing params.source → status=failed', async () => {
    const exec = loadFanOutExecutor()
    const result = await exec.execute({ as: 'item', body: [] }, makeCtx())
    expect(result.status).toBe('failed')
    expect(result.error).toContain('params.source')
  })

  it('missing params.as → status=failed', async () => {
    const exec = loadFanOutExecutor()
    const result = await exec.execute(
      { source: '{{vars.items}}', body: [] },
      makeCtx({ vars: { items: [1] as unknown as string } as unknown as Record<string, unknown> }),
    )
    expect(result.status).toBe('failed')
    expect(result.error).toContain('params.as')
  })

  it('items output preserves source order even with parallel batches', async () => {
    const exec = loadFanOutExecutor()
    const result = await exec.execute(
      {
        source: '{{vars.items}}',
        as: 'item',
        parallel: 3,
        body: [{ id: 'echo', nodeTypeKey: 'test_echo_scope', params: { scopeKey: 'item' } }],
      },
      makeCtx({ vars: { items: ['a', 'b', 'c', 'd', 'e'] as unknown as string } as unknown as Record<string, unknown> }),
    )
    expect(result.status).toBe('success')
    const items = (result.output as Record<string, unknown>).items as Array<Record<string, unknown>>
    expect(items.map((i) => i.value)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('body is empty array → each item produces undefined output, all success', async () => {
    const exec = loadFanOutExecutor()
    const result = await exec.execute(
      {
        source: '{{vars.items}}',
        as: 'item',
        body: [],
      },
      makeCtx({ vars: { items: [1, 2] as unknown as string } as unknown as Record<string, unknown> }),
    )
    expect(result.status).toBe('success')
    const output = result.output as Record<string, unknown>
    expect((output.items as unknown[])).toEqual([undefined, undefined])
    expect((output.failed as unknown[])).toEqual([])
  })
})
