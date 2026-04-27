import { describe, it, expect, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { MemorySaver } from '@langchain/langgraph'
import { buildGraphFromPipeline, type StageHooks } from '../../pipeline/graph-builder.js'
import type { PipelineGraph } from '../../pipeline/types.js'

function makeNode(id: string, stageType: string, params?: unknown): PipelineGraph['nodes'][number] {
  return {
    id, name: id, stageType: stageType as any, params: params as any,
    targetRoles: ['app'], parallel: false, timeoutSeconds: 60,
    retryCount: 0, onFailure: 'stop', position: { x: 0, y: 0 },
  } as PipelineGraph['nodes'][number]
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of stream) {}
}

describe('dryRunFlavor wrapper (script stageType)', () => {
  it("决策 'real' → 真调 hooks.runScript，写 snapshot source='real'", async () => {
    const realScript = vi.fn().mockResolvedValue({ status: 'success', output: 'ran' })
    const beforeSideEffect = vi.fn().mockResolvedValue({ decision: 'real' })
    const recordSnapshot = vi.fn().mockResolvedValue(undefined)
    const upstreamHashOf = vi.fn().mockReturnValue('hash-x')
    const graph: PipelineGraph = {
      nodes: [makeNode('s', 'script', {})],
      edges: [],
    }
    const hooks: StageHooks = {
      runScript: realScript,
      dryRunFlavor: { beforeSideEffect, recordSnapshot, upstreamHashOf },
    }
    const builder = buildGraphFromPipeline({ graph, stageContext: { runId: 1, servers: { app: [{ id: 1, host: 'h', port: 22, username: 'u', password: '', role: 'app' }] }, logDir: '/tmp' }, hooks })
    const app = (builder as any).compile({ checkpointer: new MemorySaver() })
    await drain(await app.stream({ runId: 1 }, { configurable: { thread_id: randomUUID() } }))
    expect(beforeSideEffect).toHaveBeenCalledWith('s', 'script', expect.anything())
    expect(realScript).toHaveBeenCalled()
    expect(recordSnapshot).toHaveBeenCalledWith('s', expect.objectContaining({ source: 'real' }))
  })

  it("决策 'stub' → 不调 hooks.runScript，写 snapshot source='stub'，stepOutputs 用 stub", async () => {
    const realScript = vi.fn()
    const beforeSideEffect = vi.fn().mockResolvedValue({
      decision: 'stub',
      output: { stdout: 'stubbed', stderr: '', exitCode: 0 },
    })
    const recordSnapshot = vi.fn().mockResolvedValue(undefined)
    const graph: PipelineGraph = { nodes: [makeNode('s', 'script', {})], edges: [] }
    const hooks: StageHooks = {
      runScript: realScript,
      dryRunFlavor: { beforeSideEffect, recordSnapshot, upstreamHashOf: () => 'h' },
    }
    const builder = buildGraphFromPipeline({ graph, stageContext: { runId: 1, servers: {}, logDir: '/tmp' }, hooks })
    const app = (builder as any).compile({ checkpointer: new MemorySaver() })
    const config = { configurable: { thread_id: randomUUID() } }
    await drain(await app.stream({ runId: 1 }, config))
    const snap = await app.getState(config)
    expect(realScript).not.toHaveBeenCalled()
    expect(recordSnapshot).toHaveBeenCalledWith('s', expect.objectContaining({ source: 'stub' }))
    expect(snap.values.stepOutputs?.s?.output).toEqual({ stdout: 'stubbed', stderr: '', exitCode: 0 })
  })

  it("决策 'manual' + manualOutput → 不调 hooks.runScript，stepOutputs 用 manualOutput", async () => {
    const realScript = vi.fn()
    const beforeSideEffect = vi.fn().mockResolvedValue({
      decision: 'manual',
      output: { stdout: 'manual-out', stderr: '', exitCode: 0 },
    })
    const recordSnapshot = vi.fn().mockResolvedValue(undefined)
    const graph: PipelineGraph = { nodes: [makeNode('s', 'script', {})], edges: [] }
    const hooks: StageHooks = {
      runScript: realScript,
      dryRunFlavor: { beforeSideEffect, recordSnapshot, upstreamHashOf: () => 'h' },
    }
    const builder = buildGraphFromPipeline({ graph, stageContext: { runId: 1, servers: {}, logDir: '/tmp' }, hooks })
    const app = (builder as any).compile({ checkpointer: new MemorySaver() })
    const config = { configurable: { thread_id: randomUUID() } }
    await drain(await app.stream({ runId: 1 }, config))
    const snap = await app.getState(config)
    expect(realScript).not.toHaveBeenCalled()
    expect(snap.values.stepOutputs?.s?.output).toEqual({ stdout: 'manual-out', stderr: '', exitCode: 0 })
    expect(recordSnapshot).toHaveBeenCalledWith('s', expect.objectContaining({ source: 'manual' }))
  })

  it('非副作用节点（sql_query）：不走 wrapper，直接真跑', async () => {
    // sql_query 会调 getPool()，但 execute 可能失败（测试环境无 DB），
    // 重要的是 beforeSideEffect 不被调用（非副作用节点）。
    const beforeSideEffect = vi.fn()
    const recordSnapshot = vi.fn().mockResolvedValue(undefined)
    const graph: PipelineGraph = { nodes: [makeNode('q', 'sql_query', { sqlTemplate: 'SELECT 1' })], edges: [] }
    // 需要 sql_query 注册 — 直接 import 侧效
    await import('../../pipeline/node-types/sql-query.js')
    const hooks: StageHooks = {
      runScript: async () => ({ status: 'success', output: '' }),
      dryRunFlavor: { beforeSideEffect, recordSnapshot, upstreamHashOf: () => 'h' },
    }
    const builder = buildGraphFromPipeline({ graph, stageContext: { runId: 1, servers: {}, logDir: '/tmp' }, hooks })
    const app = (builder as any).compile({ checkpointer: new MemorySaver() })
    const config = { configurable: { thread_id: randomUUID() } }
    await drain(await app.stream({ runId: 1 }, config))
    expect(beforeSideEffect).not.toHaveBeenCalled()
    // recordSnapshot is called for non-side-effect nodes too (source='real')
    expect(recordSnapshot).toHaveBeenCalledWith('q', expect.objectContaining({ source: 'real' }))
  })

  it('未传 dryRunFlavor：完全 noop，行为与生产一致（runScript 被调用）', async () => {
    const realScript = vi.fn().mockResolvedValue({ status: 'success', output: 'ran' })
    const graph: PipelineGraph = { nodes: [makeNode('s', 'script', {})], edges: [] }
    const hooks: StageHooks = {
      runScript: realScript,
    }
    const builder = buildGraphFromPipeline({ graph, stageContext: { runId: 1, servers: { app: [{ id: 1, host: 'h', port: 22, username: 'u', password: '', role: 'app' }] }, logDir: '/tmp' }, hooks })
    const app = (builder as any).compile({ checkpointer: new MemorySaver() })
    await drain(await app.stream({ runId: 1 }, { configurable: { thread_id: randomUUID() } }))
    expect(realScript).toHaveBeenCalled()
  })
})
