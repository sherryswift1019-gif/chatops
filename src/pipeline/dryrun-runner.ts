/**
 * dryrun-runner — T5 implementation.
 *
 * Ties together: advisory lock, session map, DryRunFlavor, graph truncation,
 * PostgresSaver checkpointer, LangGraph stream loop, SSE push protocol.
 *
 * Public API:
 *   runDryRun(opts)            — start a dry-run execution
 *   decideSideEffect(...)      — resume a pending decision waiter
 */

import { computeAncestors } from './graph-validation.js'
import { computeUpstreamHash } from './dryrun-hash.js'
import { generateStubFromSchema } from './dryrun-stub.js'
import { upsertSnapshot } from '../db/repositories/dryrun-snapshots.js'
import { getTestPipelineById } from '../db/repositories/test-pipelines.js'
import { getPool } from '../db/client.js'
import { getCheckpointer } from './graph-runtime.js'
import { buildDefaultHooks } from './executor-hooks.js'
import { buildGraphFromPipeline, type DryRunFlavor, type StageHooks } from './graph-builder.js'
import type { PipelineGraph } from './types.js'
// Trigger self-registration of all NodeExecutor implementations (sql_query,
// http, db_update, dm, file_read, template_render, fan_out, switch, etc.)
// so getExecutor() resolves correctly during dry-run graph execution.
import './node-types/index.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SsePushFn {
  (chunk: { type: string; [k: string]: unknown }): void
}

export interface RunDryRunOpts {
  sessionId: string
  pipelineId: number
  /** Node id to run UP TO (exclusive). Use '*' to run the whole graph. */
  targetNodeId: string
  triggerParams: Record<string, unknown>
  triggerType: string
  triggeredBy: string
  ssePush: SsePushFn
}

type DecisionPayload = {
  decision: 'real' | 'stub' | 'manual'
  output?: Record<string, unknown>
  remember?: boolean
}

interface SessionState {
  pipelineId: number
  threadId: string
  decisionWaiters: Map<string, (d: DecisionPayload) => void>
  startedAt: Date
}

// ---------------------------------------------------------------------------
// Session map + TTL cleanup
// ---------------------------------------------------------------------------

const sessions = new Map<string, SessionState>()
const SESSION_TTL_MS = 30 * 60 * 1000

// Cleanup old sessions every minute. `.unref()` so this timer doesn't keep
// the Node.js event loop alive in test environments.
setInterval(() => {
  const now = Date.now()
  for (const [sid, s] of sessions) {
    if (now - s.startedAt.getTime() > SESSION_TTL_MS) sessions.delete(sid)
  }
}, 60_000).unref()

// ---------------------------------------------------------------------------
// truncateGraphBefore
// ---------------------------------------------------------------------------

/**
 * Return a subgraph containing only the ancestors of `targetNodeId`
 * (not including `targetNodeId` itself). When `targetNodeId` is the entry
 * node (no ancestors), returns `{ nodes: [], edges: [] }`.
 */
function truncateGraphBefore(graph: PipelineGraph, targetNodeId: string): PipelineGraph {
  const keepIds = computeAncestors(graph, targetNodeId) // Set<string>, does NOT include target itself
  if (keepIds.size === 0) {
    return { nodes: [], edges: [] }
  }
  return {
    nodes: graph.nodes.filter(n => keepIds.has(n.id)),
    edges: graph.edges.filter(e => keepIds.has(e.source) && keepIds.has(e.target)),
  }
}

// ---------------------------------------------------------------------------
// runDryRun
// ---------------------------------------------------------------------------

export async function runDryRun(opts: RunDryRunOpts): Promise<void> {
  const { sessionId, pipelineId, targetNodeId, triggerParams, ssePush } = opts

  // 1. Advisory lock — prevents concurrent dry-runs on the same pipeline.
  //    pg_try_advisory_lock takes a bigint key; pipelineId is an integer, safe.
  const { rows: lockRows } = await getPool().query(
    `SELECT pg_try_advisory_lock($1) AS locked`,
    [pipelineId],
  )
  if (!lockRows[0].locked) {
    throw new Error(`advisory lock: concurrent dry-run already running for pipeline ${pipelineId}`)
  }

  try {
    // 2. Load pipeline from DB.
    const pipeline = await getTestPipelineById(pipelineId)
    if (!pipeline) throw new Error(`pipeline ${pipelineId} not found`)
    const graph = (pipeline.graph ?? null) as PipelineGraph | null
    if (!graph) throw new Error(`pipeline ${pipelineId} has no graph`)

    // 3. Truncate graph to ancestors of targetNodeId.
    const subgraph: PipelineGraph =
      targetNodeId === '*' ? graph : truncateGraphBefore(graph, targetNodeId)

    // 4. Register session.
    const threadId = `dryrun-${sessionId}-${Date.now()}`
    sessions.set(sessionId, {
      pipelineId,
      threadId,
      decisionWaiters: new Map(),
      startedAt: new Date(),
    })

    // 5. Build DryRunFlavor.
    const flavor: DryRunFlavor = {
      beforeSideEffect: async (nodeId, stageType, params) => {
        // Look up output_schema from pipeline_node_types for stub template generation.
        const { rows } = await getPool().query(
          `SELECT output_schema FROM pipeline_node_types WHERE key=$1`,
          [stageType],
        )
        const schemaTemplate: Record<string, unknown> = (rows[0]?.output_schema ?? {}) as Record<string, unknown>

        // Push decision-needed SSE chunk.
        ssePush({
          type: 'decision-needed',
          sessionId,
          nodeId,
          stageType,
          params,
          schemaTemplate: generateStubFromSchema(schemaTemplate),
        })

        // Wait for the frontend to POST decideSideEffect.
        return new Promise<{ decision: 'real' | 'stub' | 'manual'; output?: Record<string, unknown> }>((resolve) => {
          const sess = sessions.get(sessionId)
          if (!sess) {
            resolve({ decision: 'stub' })
            return
          }
          sess.decisionWaiters.set(nodeId, resolve)
        })
      },

      recordSnapshot: async (nodeId, snap) => {
        await upsertSnapshot({
          pipelineId,
          nodeId,
          status: snap.status,
          output: snap.output,
          source: snap.source,
          upstreamParamsHash: computeUpstreamHash(graph, nodeId),
          lastDecision: snap.source !== 'real' ? snap.source : null,
          lastManualInput: snap.source === 'manual' ? snap.output : null,
          durationMs: snap.durationMs,
          error: snap.error ?? null,
        })
        ssePush({
          type: 'snapshot',
          nodeId,
          status: snap.status,
          source: snap.source,
          output: snap.output,
        })
      },

      upstreamHashOf: (nodeId) => computeUpstreamHash(graph, nodeId),
    }

    // 6. Build hooks: DryRunFlavor + prod runScript/runCapability from executor-hooks.
    //    The logDir is not meaningful for dry-run (script nodes are intercepted by
    //    the dryRunFlavor wrapper before runScript is invoked for 'stub'/'manual').
    const prodHooks: StageHooks = buildDefaultHooks('/tmp/dryrun')
    const hooks: StageHooks = {
      ...prodHooks,
      dryRunFlavor: flavor,
    }

    // 7. Compile graph with PostgresSaver checkpointer.
    const checkpointer = await getCheckpointer()
    const builder = buildGraphFromPipeline({
      graph: subgraph,
      stageContext: {
        runId: 0, // dry-run has no real run id
        servers: {},
        logDir: '/tmp/dryrun',
      },
      hooks,
      triggerParams,
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const app = (builder as any).compile({ checkpointer })
    const config = { configurable: { thread_id: threadId } }

    // 8. Stream execution.
    ssePush({ type: 'started', sessionId })

    // LangGraph stream yields chunks of shape { [nodeName]: stateUpdate }.
    // Each key is the graph node name that just completed.
    const stream = await app.stream({ runId: 0 }, config) as AsyncIterable<Record<string, unknown>>
    for await (const chunk of stream) {
      // Extract node names from the chunk (langgraph streams one node per chunk).
      const nodeNames = Object.keys(chunk).filter(k => k !== '__end__')
      for (const nodeName of nodeNames) {
        ssePush({ type: 'progress', nodeName })
      }
    }

    ssePush({ type: 'done', sessionId, targetNodeId })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    ssePush({ type: 'error', error: msg, fatal: true })
    throw e
  } finally {
    sessions.delete(sessionId)
    await getPool().query(`SELECT pg_advisory_unlock($1)`, [pipelineId])
  }
}

// ---------------------------------------------------------------------------
// decideSideEffect
// ---------------------------------------------------------------------------

/**
 * Called by the admin route when the frontend POSTs a decision for a
 * pending side-effect node. Resolves the promise that `beforeSideEffect`
 * is awaiting in the graph execution loop.
 */
export async function decideSideEffect(
  sessionId: string,
  nodeId: string,
  decision: DecisionPayload,
): Promise<void> {
  const session = sessions.get(sessionId)
  if (!session) throw new Error(`session ${sessionId} not found or expired`)

  const waiter = session.decisionWaiters.get(nodeId)
  if (!waiter) throw new Error(`no pending decision for node ${nodeId} in session ${sessionId}`)

  // Optional: persist the user's decision choice for next run pre-fill.
  if (decision.remember) {
    await getPool().query(
      `UPDATE pipeline_dryrun_snapshots
       SET last_decision = $3, last_manual_input = $4
       WHERE pipeline_id = $1 AND node_id = $2`,
      [
        session.pipelineId,
        nodeId,
        decision.decision,
        decision.output ? JSON.stringify(decision.output) : null,
      ],
    )
  }

  waiter(decision)
  session.decisionWaiters.delete(nodeId)
}
