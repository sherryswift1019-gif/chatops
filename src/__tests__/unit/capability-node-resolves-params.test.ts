/**
 * End-to-end-ish unit test for buildCapabilityNode param resolution.
 *
 * Reproduces the bug found in PAM Proxy pipeline: capabilityParams contains
 * `{{steps.<id>.output.<key>}}` and `{{vars.<obj>.<field>}}` templates, but
 * the legacy resolveCapabilityParams only matched single-segment whole-string
 * templates so the hook saw the raw `{{...}}` literal and downstream calls
 * (the LLM agent / capability) tried to URL-encode the literal.
 *
 * The fix: buildCapabilityNode resolves params **before** calling the hook
 * via the new 2-arg overload (params, varCtx) which threads steps/scopes
 * through resolvePath.
 */
import { describe, it, expect, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { MemorySaver } from '@langchain/langgraph'
import { buildGraphFromPipeline, type StageHooks } from '../../pipeline/graph-builder.js'
import type { PipelineGraph, StageDefinition, StageContext } from '../../pipeline/types.js'

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

function llmNode(
  id: string,
  name: string,
  capabilityParams: Record<string, unknown>,
): PipelineGraph['nodes'][number] {
  return {
    id, name,
    stageType: 'llm_agent',
    capabilityKey: 'k',
    capabilityParams,
    outputFormat: 'string',
    targetRoles: [], parallel: false, timeoutSeconds: 60,
    retryCount: 0, onFailure: 'stop',
    position: { x: 0, y: 0 },
  }
}

describe('buildCapabilityNode: hook receives resolved params (not raw templates)', () => {
  it('resolves {{triggerParams.x}} before calling the hook (legacy path, regression guard)', async () => {
    let received: Record<string, unknown> | undefined
    const hook = vi.fn(async (
      stage: StageDefinition,
      _ctx: StageContext,
      _tp?: Record<string, unknown>,
      _rv?: Record<string, unknown>,
    ) => {
      received = stage.capabilityParams
      return { status: 'success' as const, output: 'ok' }
    })
    const graph: PipelineGraph = {
      nodes: [llmNode('q1', 'q', { ref: '{{triggerParams.branch}}' })],
      edges: [],
    }
    const hooks: StageHooks = {
      runScript: async () => ({ status: 'success', output: '' }),
      runCapability: hook,
    }
    const builder = buildGraphFromPipeline({
      graph, stageContext: baseCtx(), hooks,
      triggerParams: { branch: 'main' },
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const app = (builder as any).compile({ checkpointer: new MemorySaver() })
    const config = { configurable: { thread_id: randomUUID() } }
    await drain(await app.stream({ runId: 42 }, config))
    expect(received).toEqual({ ref: 'main' })
  })

  it('resolves {{steps.<id>.output.<key>}} before calling the hook', async () => {
    let receivedB: Record<string, unknown> | undefined
    const hookA = vi.fn(async () => ({ status: 'success' as const, output: 'A done' }))
    const hookB = vi.fn(async (
      stage: StageDefinition,
    ) => {
      receivedB = stage.capabilityParams
      return { status: 'success' as const, output: 'B done' }
    })
    // Two nodes: A produces a stepOutput (json), B references {{steps.A.output.id}}.
    // We have to manually seed stepOutputs since llm_agent only writes them when
    // outputFormat='json'. Easier: use outputFormat='json' on A.
    const nodeA: PipelineGraph['nodes'][number] = {
      id: 'A', name: 'A',
      stageType: 'llm_agent',
      capabilityKey: 'k',
      outputFormat: 'json',
      targetRoles: [], parallel: false, timeoutSeconds: 60,
      retryCount: 0, onFailure: 'stop',
      position: { x: 0, y: 0 },
    }
    const nodeB = llmNode('B', 'B', {
      uid: '{{steps.A.output.id}}',
      uname: '{{steps.A.output.name}}',
    })
    const graph: PipelineGraph = {
      nodes: [nodeA, nodeB],
      edges: [{ id: 'e1', source: 'A', target: 'B' }],
    }
    const hookCombined = vi.fn(async (
      stage: StageDefinition,
    ) => {
      if (stage.name === 'A') return hookA()
      return hookB(stage)
    })
    // hookA returns JSON, hookB receives resolved params
    hookA.mockResolvedValue({ status: 'success', output: '{"id": 7, "name": "alice"}' })

    const hooks: StageHooks = {
      runScript: async () => ({ status: 'success', output: '' }),
      runCapability: hookCombined,
    }
    const builder = buildGraphFromPipeline({ graph, stageContext: baseCtx(), hooks })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const app = (builder as any).compile({ checkpointer: new MemorySaver() })
    const config = { configurable: { thread_id: randomUUID() } }
    await drain(await app.stream({ runId: 42 }, config))
    expect(receivedB).toEqual({ uid: 7, uname: 'alice' })
  })

  it('resolves nested {{vars.<obj>.<field>}} before calling the hook', async () => {
    let received: Record<string, unknown> | undefined
    const hook = vi.fn(async (
      stage: StageDefinition,
    ) => {
      received = stage.capabilityParams
      return { status: 'success' as const, output: 'ok' }
    })
    const graph: PipelineGraph = {
      nodes: [llmNode('q1', 'q', {
        host: '{{vars.config.host}}',
        port: '{{vars.config.port}}',
      })],
      edges: [],
    }
    const hooks: StageHooks = {
      runScript: async () => ({ status: 'success', output: '' }),
      runCapability: hook,
    }
    const builder = buildGraphFromPipeline({
      graph,
      stageContext: {
        ...baseCtx(),
        // ctxBase.variables 是 Record<string, string>，但实际运行时 runtimeVars
        // (state.runtimeVars) 是 Record<string, unknown>，所以 nested 对象通过
        // wait_webhook / im_input 写入是常态。这里直接用 runtimeVars 路径模拟。
      },
      hooks,
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const app = (builder as any).compile({ checkpointer: new MemorySaver() })
    const config = { configurable: { thread_id: randomUUID() } }
    await drain(await app.stream({
      runId: 42,
      runtimeVars: { config: { host: 'srv.example.com', port: 8080 } },
    }, config))
    expect(received).toEqual({ host: 'srv.example.com', port: 8080 })
  })
})
