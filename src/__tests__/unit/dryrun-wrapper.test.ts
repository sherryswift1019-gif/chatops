import { describe, it, expect, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { MemorySaver } from '@langchain/langgraph'
import { buildGraphFromPipeline, type StageHooks } from '../../pipeline/graph-builder.js'
import type { PipelineGraph } from '../../pipeline/types.js'

function makeNode(id: string, stageType: string, params?: unknown): PipelineGraph['nodes'][number] {
  return {
    id, name: id, stageType: stageType as any, params: params as any,
    targetRoles: [], parallel: false, timeoutSeconds: 60,
    retryCount: 0, onFailure: 'stop', position: { x: 0, y: 0 },
  } as PipelineGraph['nodes'][number]
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of stream) {}
}

describe('dryRunFlavor wrapper', () => {
  it("决策 'real' → 真调 hooks，写 snapshot source='real'", async () => {
    const realDm = vi.fn().mockResolvedValue({ status: 'success', output: 'sent' })
    const beforeSideEffect = vi.fn().mockResolvedValue({ decision: 'real' })
    const recordSnapshot = vi.fn().mockResolvedValue(undefined)
    const upstreamHashOf = vi.fn().mockReturnValue('hash-x')
    const graph: PipelineGraph = {
      nodes: [makeNode('d', 'dm', { target: 'u', text: 'hi' })],
      edges: [],
    }
    const hooks: StageHooks = {
      runScript: async () => ({ status: 'success', output: '' }),
      runDm: realDm,
      dryRunFlavor: { beforeSideEffect, recordSnapshot, upstreamHashOf },
    }
    const builder = buildGraphFromPipeline({ graph, stageContext: { runId: 1, servers: {}, logDir: '/tmp' }, hooks })
    const app = (builder as any).compile({ checkpointer: new MemorySaver() })
    await drain(await app.stream({ runId: 1 }, { configurable: { thread_id: randomUUID() } }))
    expect(beforeSideEffect).toHaveBeenCalledWith('d', 'dm', expect.any(Object))
    expect(realDm).toHaveBeenCalled()
    expect(recordSnapshot).toHaveBeenCalledWith('d', expect.objectContaining({ source: 'real' }))
  })

  it("决策 'stub' → 不调 hooks，写 snapshot source='stub'，stepOutputs 用 stub", async () => {
    const realDm = vi.fn()
    const beforeSideEffect = vi.fn().mockResolvedValue({
      decision: 'stub',
      output: { messageId: '', deliveredAt: '' },
    })
    const recordSnapshot = vi.fn().mockResolvedValue(undefined)
    const graph: PipelineGraph = { nodes: [makeNode('d', 'dm', {})], edges: [] }
    const hooks: StageHooks = {
      runScript: async () => ({ status: 'success', output: '' }),
      runDm: realDm,
      dryRunFlavor: { beforeSideEffect, recordSnapshot, upstreamHashOf: () => 'h' },
    }
    const builder = buildGraphFromPipeline({ graph, stageContext: { runId: 1, servers: {}, logDir: '/tmp' }, hooks })
    const app = (builder as any).compile({ checkpointer: new MemorySaver() })
    const config = { configurable: { thread_id: randomUUID() } }
    await drain(await app.stream({ runId: 1 }, config))
    const snap = await app.getState(config)
    expect(realDm).not.toHaveBeenCalled()
    expect(recordSnapshot).toHaveBeenCalledWith('d', expect.objectContaining({ source: 'stub' }))
    expect(snap.values.stepOutputs?.d?.output).toEqual({ messageId: '', deliveredAt: '' })
  })

  it("决策 'manual' + manualOutput → 不调 hooks，stepOutputs 用 manualOutput", async () => {
    const realDm = vi.fn()
    const beforeSideEffect = vi.fn().mockResolvedValue({
      decision: 'manual',
      output: { messageId: 'fake-123', deliveredAt: '2026-04-27T00:00:00Z' },
    })
    const recordSnapshot = vi.fn().mockResolvedValue(undefined)
    const graph: PipelineGraph = { nodes: [makeNode('d', 'dm', {})], edges: [] }
    const hooks: StageHooks = {
      runScript: async () => ({ status: 'success', output: '' }),
      runDm: realDm,
      dryRunFlavor: { beforeSideEffect, recordSnapshot, upstreamHashOf: () => 'h' },
    }
    const builder = buildGraphFromPipeline({ graph, stageContext: { runId: 1, servers: {}, logDir: '/tmp' }, hooks })
    const app = (builder as any).compile({ checkpointer: new MemorySaver() })
    const config = { configurable: { thread_id: randomUUID() } }
    await drain(await app.stream({ runId: 1 }, config))
    const snap = await app.getState(config)
    expect(realDm).not.toHaveBeenCalled()
    expect(snap.values.stepOutputs?.d?.output).toEqual({ messageId: 'fake-123', deliveredAt: '2026-04-27T00:00:00Z' })
    expect(recordSnapshot).toHaveBeenCalledWith('d', expect.objectContaining({ source: 'manual' }))
  })

  it('非副作用节点（sql_query）：不走 wrapper，直接真跑', async () => {
    const beforeSideEffect = vi.fn()
    const recordSnapshot = vi.fn().mockResolvedValue(undefined)
    const graph: PipelineGraph = { nodes: [makeNode('q', 'sql_query', {})], edges: [] }
    const hooks: StageHooks = {
      runScript: async () => ({ status: 'success', output: '' }),
      dryRunFlavor: { beforeSideEffect, recordSnapshot, upstreamHashOf: () => 'h' },
    }
    const builder = buildGraphFromPipeline({ graph, stageContext: { runId: 1, servers: {}, logDir: '/tmp' }, hooks })
    const app = (builder as any).compile({ checkpointer: new MemorySaver() })
    const config = { configurable: { thread_id: randomUUID() } }
    await drain(await app.stream({ runId: 1 }, config))
    expect(beforeSideEffect).not.toHaveBeenCalled()
    expect(recordSnapshot).toHaveBeenCalledWith('q', expect.objectContaining({ source: 'real' }))
  })

  it('未传 dryRunFlavor：完全 noop，行为与生产一致', async () => {
    const realDm = vi.fn().mockResolvedValue({ status: 'success', output: 'sent' })
    const graph: PipelineGraph = { nodes: [makeNode('d', 'dm', {})], edges: [] }
    const hooks: StageHooks = {
      runScript: async () => ({ status: 'success', output: '' }),
      runDm: realDm,
    }
    const builder = buildGraphFromPipeline({ graph, stageContext: { runId: 1, servers: {}, logDir: '/tmp' }, hooks })
    const app = (builder as any).compile({ checkpointer: new MemorySaver() })
    await drain(await app.stream({ runId: 1 }, { configurable: { thread_id: randomUUID() } }))
    expect(realDm).toHaveBeenCalled()
  })
})
