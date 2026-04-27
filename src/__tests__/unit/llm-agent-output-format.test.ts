import { describe, it, expect, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { MemorySaver } from '@langchain/langgraph'
import { buildGraphFromPipeline, type StageHooks } from '../../pipeline/graph-builder.js'
import type { PipelineGraph } from '../../pipeline/types.js'

function baseCtx() {
  return {
    runId: 42,
    servers: {} as Record<string, never[]>,
    logDir: '/tmp/chatops-test',
  }
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) { /* drain */ }
}

function makeLlmNode(id: string, name: string, outputFormat?: 'string' | 'json'): PipelineGraph['nodes'][number] {
  return {
    id, name,
    stageType: 'llm_agent',
    capabilityKey: 'k',
    outputFormat,
    targetRoles: [], parallel: false, timeoutSeconds: 60,
    retryCount: 0, onFailure: 'stop',
    position: { x: 0, y: 0 },
  }
}

describe('buildCapabilityNode outputFormat', () => {
  it("默认 outputFormat='json'：合法 JSON object → 写 stepOutputs", async () => {
    const hook = vi.fn().mockResolvedValue({ status: 'success', output: '{"intent":"rollback","score":90}' })
    const graph: PipelineGraph = {
      nodes: [makeLlmNode('q1', 'q')],
      edges: [],
    }
    const hooks: StageHooks = {
      runScript: async () => ({ status: 'success', output: '' }),
      runCapability: hook,
    }
    const builder = buildGraphFromPipeline({ graph, stageContext: baseCtx(), hooks })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const app = (builder as any).compile({ checkpointer: new MemorySaver() })
    const config = { configurable: { thread_id: randomUUID() } }
    await drain(await app.stream({ runId: 42 }, config))
    const snap = await app.getState(config)
    expect(snap.values.stepOutputs?.q1?.output).toEqual({ intent: 'rollback', score: 90 })
    expect(snap.values.stageResults[0].status).toBe('success')
  })

  it("outputFormat='json' + 非 object（数组）→ stage failed", async () => {
    const hook = vi.fn().mockResolvedValue({ status: 'success', output: '[1,2,3]' })
    const graph: PipelineGraph = {
      nodes: [makeLlmNode('q1', 'q', 'json')],
      edges: [],
    }
    const hooks: StageHooks = {
      runScript: async () => ({ status: 'success', output: '' }),
      runCapability: hook,
    }
    const builder = buildGraphFromPipeline({ graph, stageContext: baseCtx(), hooks })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const app = (builder as any).compile({ checkpointer: new MemorySaver() })
    const config = { configurable: { thread_id: randomUUID() } }
    await drain(await app.stream({ runId: 42 }, config))
    const snap = await app.getState(config)
    expect(snap.values.stageResults[0].status).toBe('failed')
    expect(snap.values.stageResults[0].error).toMatch(/JSON 对象/)
  })

  it("outputFormat='json' + parse 失败 → stage failed", async () => {
    const hook = vi.fn().mockResolvedValue({ status: 'success', output: 'not json' })
    const graph: PipelineGraph = {
      nodes: [makeLlmNode('q1', 'q', 'json')],
      edges: [],
    }
    const hooks: StageHooks = {
      runScript: async () => ({ status: 'success', output: '' }),
      runCapability: hook,
    }
    const builder = buildGraphFromPipeline({ graph, stageContext: baseCtx(), hooks })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const app = (builder as any).compile({ checkpointer: new MemorySaver() })
    const config = { configurable: { thread_id: randomUUID() } }
    await drain(await app.stream({ runId: 42 }, config))
    const snap = await app.getState(config)
    expect(snap.values.stageResults[0].status).toBe('failed')
    expect(snap.values.stageResults[0].error).toMatch(/parse 失败/)
  })

  it("outputFormat='string'：保持现状，不写 stepOutputs", async () => {
    const hook = vi.fn().mockResolvedValue({ status: 'success', output: 'plain text' })
    const graph: PipelineGraph = {
      nodes: [makeLlmNode('q1', 'q', 'string')],
      edges: [],
    }
    const hooks: StageHooks = {
      runScript: async () => ({ status: 'success', output: '' }),
      runCapability: hook,
    }
    const builder = buildGraphFromPipeline({ graph, stageContext: baseCtx(), hooks })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const app = (builder as any).compile({ checkpointer: new MemorySaver() })
    const config = { configurable: { thread_id: randomUUID() } }
    await drain(await app.stream({ runId: 42 }, config))
    const snap = await app.getState(config)
    expect(snap.values.stageResults[0].status).toBe('success')
    expect(snap.values.stepOutputs?.q1).toBeUndefined()
  })
})
