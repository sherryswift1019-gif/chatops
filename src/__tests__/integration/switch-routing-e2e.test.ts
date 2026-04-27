import { describe, it, expect, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { MemorySaver } from '@langchain/langgraph'
import '../../pipeline/node-types/index.js'
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

function makeLlmNode(id: string, name: string, capabilityKey = 'classify'): PipelineGraph['nodes'][number] {
  return {
    id, name,
    stageType: 'llm_agent',
    capabilityKey,
    outputFormat: 'json',
    targetRoles: [], parallel: false, timeoutSeconds: 60,
    retryCount: 0, onFailure: 'stop',
    position: { x: 0, y: 0 },
  }
}

function makeSqlNode(id: string, name: string): PipelineGraph['nodes'][number] {
  return {
    id, name,
    stageType: 'sql_query',
    targetRoles: [], parallel: false, timeoutSeconds: 60,
    retryCount: 0, onFailure: 'stop',
    position: { x: 0, y: 0 },
  }
}

function makeSwitchNode(id: string, name: string, params: { cases: Array<{when: string; target: string}>; default: string }): PipelineGraph['nodes'][number] {
  return {
    id, name,
    stageType: 'switch',
    params,
    targetRoles: [], parallel: false, timeoutSeconds: 60,
    retryCount: 0, onFailure: 'stop',
    position: { x: 0, y: 0 },
  } as PipelineGraph['nodes'][number]
}

function buildBaseGraph(): PipelineGraph {
  return {
    nodes: [
      makeLlmNode('q', 'classify'),
      makeSwitchNode('sw', 'route', {
        cases: [
          { when: "steps.q.output.intent == 'rollback'", target: 'rb' },
          { when: "steps.q.output.intent == 'deploy'", target: 'dp' },
        ],
        default: 'manual',
      }),
      makeSqlNode('rb', 'rollback'),
      makeSqlNode('dp', 'deploy'),
      makeSqlNode('manual', 'manual'),
    ],
    edges: [
      { source: 'q', target: 'sw' },
      { source: 'sw', target: 'rb' },
      { source: 'sw', target: 'dp' },
      { source: 'sw', target: 'manual' },
    ],
  }
}

interface SR { name: string; status: 'success' | 'failed' | 'skipped'; error?: string }

function findResult(results: SR[], name: string): SR | undefined {
  return results.find(r => r.name === name)
}

/** wasSelected：节点被路由命中并真实执行（success 或 failed，但不是 skipped 也非 absent） */
function wasSelected(results: SR[], name: string): boolean {
  const r = findResult(results, name)
  return r != null && r.status !== 'skipped'
}

describe('switch routing e2e', () => {
  it("LLM 产出 {intent:'rollback'} → 路由命中 rollback，deploy/manual 未被选中", async () => {
    const runCapability = vi.fn().mockResolvedValue({ status: 'success', output: '{"intent":"rollback","score":90}' })
    const hooks: StageHooks = {
      runScript: async () => ({ status: 'success', output: '' }),
      runCapability,
    }
    const builder = buildGraphFromPipeline({ graph: buildBaseGraph(), stageContext: baseCtx(), hooks })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const app = (builder as any).compile({ checkpointer: new MemorySaver() })
    const config = { configurable: { thread_id: randomUUID() } }
    await drain(await app.stream({ runId: 42 }, config))
    const snap = await app.getState(config)
    const results = snap.values.stageResults as SR[]

    expect(findResult(results, 'classify')?.status).toBe('success')
    expect(findResult(results, 'route')?.status).toBe('success')
    expect(wasSelected(results, 'rollback')).toBe(true)
    expect(wasSelected(results, 'deploy')).toBe(false)
    expect(wasSelected(results, 'manual')).toBe(false)
    expect(snap.values.stepOutputs?.sw?.output).toMatchObject({
      matchedCaseIndex: 0,
      matchedTarget: 'rb',
    })
  })

  it("LLM 产出 {intent:'unknown'} → 路由走 default(manual)", async () => {
    const runCapability = vi.fn().mockResolvedValue({ status: 'success', output: '{"intent":"unknown"}' })
    const hooks: StageHooks = {
      runScript: async () => ({ status: 'success', output: '' }),
      runCapability,
    }
    const builder = buildGraphFromPipeline({ graph: buildBaseGraph(), stageContext: baseCtx(), hooks })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const app = (builder as any).compile({ checkpointer: new MemorySaver() })
    const config = { configurable: { thread_id: randomUUID() } }
    await drain(await app.stream({ runId: 42 }, config))
    const snap = await app.getState(config)
    const results = snap.values.stageResults as SR[]

    expect(findResult(results, 'classify')?.status).toBe('success')
    expect(findResult(results, 'route')?.status).toBe('success')
    expect(wasSelected(results, 'manual')).toBe(true)
    expect(wasSelected(results, 'rollback')).toBe(false)
    expect(wasSelected(results, 'deploy')).toBe(false)
    expect(snap.values.stepOutputs?.sw?.output).toMatchObject({
      matchedCaseIndex: null,
      matchedTarget: 'manual',
    })
  })

  it('LLM 产出非 JSON 字符串 → classify failed，switch 与下游全未被选中', async () => {
    const runCapability = vi.fn().mockResolvedValue({ status: 'success', output: 'not json' })
    const hooks: StageHooks = {
      runScript: async () => ({ status: 'success', output: '' }),
      runCapability,
    }
    const builder = buildGraphFromPipeline({ graph: buildBaseGraph(), stageContext: baseCtx(), hooks })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const app = (builder as any).compile({ checkpointer: new MemorySaver() })
    const config = { configurable: { thread_id: randomUUID() } }
    await drain(await app.stream({ runId: 42 }, config))
    const snap = await app.getState(config)
    const results = snap.values.stageResults as SR[]

    expect(findResult(results, 'classify')?.status).toBe('failed')
    expect(findResult(results, 'classify')?.error).toMatch(/parse 失败/)
    expect(wasSelected(results, 'route')).toBe(false)
    expect(wasSelected(results, 'rollback')).toBe(false)
    expect(wasSelected(results, 'deploy')).toBe(false)
    expect(wasSelected(results, 'manual')).toBe(false)
  })
})
