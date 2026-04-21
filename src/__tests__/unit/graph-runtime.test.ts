import { describe, it, expect, beforeAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { StateGraph, START, END, MemorySaver } from '@langchain/langgraph'
import { Pool } from 'pg'
import { PipelineStateAnnotation } from '../../pipeline/graph-state.js'
import { getCheckpointer, resetCheckpointerForTesting } from '../../pipeline/graph-runtime.js'

// The vitest setup file (src/__tests__/helpers/db.ts) always sets DATABASE_URL
// to a dummy value if the environment didn't provide one, so the presence of
// DATABASE_URL alone isn't proof that a Postgres is reachable. We actively
// probe the connection before deciding which saver to use.
async function canReachPostgres(): Promise<boolean> {
  const url = process.env.DATABASE_URL
  if (!url) return false
  const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 1500 })
  try {
    await pool.query('SELECT 1')
    return true
  } catch {
    return false
  } finally {
    await pool.end().catch(() => undefined)
  }
}

let postgresReachable = false

beforeAll(async () => {
  postgresReachable = await canReachPostgres()
  // Make sure we build a fresh singleton against whatever DATABASE_URL vitest
  // ends up using for this process.
  resetCheckpointerForTesting()
})

// 3-node graph: START -> a -> b -> END.
// a writes runtimeVars.foo = 'a'; b reads foo and writes runtimeVars.bar = 'b'.
function buildGraph() {
  const builder = new StateGraph(PipelineStateAnnotation)
    .addNode('a', async () => ({
      runtimeVars: { foo: 'a' },
    }))
    .addNode('b', async (state) => {
      // Assert that a's write is visible to b through the merge reducer.
      if (state.runtimeVars.foo !== 'a') {
        throw new Error(`expected runtimeVars.foo='a' in node b, got ${String(state.runtimeVars.foo)}`)
      }
      return { runtimeVars: { bar: 'b' } }
    })
    .addEdge(START, 'a')
    .addEdge('a', 'b')
    .addEdge('b', END)
  return builder
}

describe('graph-runtime smoke (MemorySaver fallback)', () => {
  it('runs a→b through MemorySaver and preserves runtimeVars', async () => {
    const graph = buildGraph().compile({ checkpointer: new MemorySaver() })
    const config = { configurable: { thread_id: randomUUID() } }
    const final = await graph.invoke({ runId: 42 }, config)
    expect(final.runtimeVars.foo).toBe('a')
    expect(final.runtimeVars.bar).toBe('b')
    expect(final.runId).toBe(42)

    const snapshot = await graph.getState(config)
    expect(snapshot.values.runtimeVars.foo).toBe('a')
    expect(snapshot.values.runtimeVars.bar).toBe('b')
  })

  it('stageResults reducer merges by name', async () => {
    const builder = new StateGraph(PipelineStateAnnotation)
      .addNode('write1', async () => ({
        stageResults: [{ name: 's1', type: 'script', status: 'running' as const }],
      }))
      .addNode('write2', async () => ({
        stageResults: [
          { name: 's2', type: 'script', status: 'success' as const },
          { name: 's1', type: 'script', status: 'success' as const },
        ],
      }))
      .addEdge(START, 'write1')
      .addEdge('write1', 'write2')
      .addEdge('write2', END)
    const graph = builder.compile({ checkpointer: new MemorySaver() })
    const config = { configurable: { thread_id: randomUUID() } }
    const final = await graph.invoke({ runId: 1 }, config)
    expect(final.stageResults).toHaveLength(2)
    const s1 = final.stageResults.find((r) => r.name === 's1')
    expect(s1?.status).toBe('success')
    expect(final.terminated).toBe(false)
  })

  it('terminated reducer latches to true', async () => {
    const builder = new StateGraph(PipelineStateAnnotation)
      .addNode('set', async () => ({ terminated: true }))
      .addNode('clear', async () => ({ terminated: false }))
      .addEdge(START, 'set')
      .addEdge('set', 'clear')
      .addEdge('clear', END)
    const graph = builder.compile({ checkpointer: new MemorySaver() })
    const final = await graph.invoke({ runId: 1 }, { configurable: { thread_id: randomUUID() } })
    expect(final.terminated).toBe(true)
  })
})

describe('graph-runtime smoke (PostgresSaver, live DB only)', () => {
  it('persists checkpoint to Postgres and round-trips state', async () => {
    if (!postgresReachable) {
      // Not using it.skipIf(...) on the describe because we need the async
      // probe result from beforeAll.
      return
    }
    const checkpointer = await getCheckpointer()
    const graph = buildGraph().compile({ checkpointer })
    const threadId = randomUUID()
    const config = { configurable: { thread_id: threadId } }

    // Drive the graph via .stream so we exercise the streaming path too,
    // then fetch the final state.
    for await (const _chunk of await graph.stream({ runId: 99 }, config)) {
      // intentionally empty — we just want to drain the stream
    }
    const snapshot = await graph.getState(config)
    expect(snapshot.values.runtimeVars.foo).toBe('a')
    expect(snapshot.values.runtimeVars.bar).toBe('b')
    expect(snapshot.values.runId).toBe(99)
  })
})
