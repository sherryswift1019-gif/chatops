/**
 * dryrun e2e 集成测试 — Task 14
 *
 * 真后端 + 真 SSE（app.listen({port:0}) + fetch）验证三场景：
 *   1. 简单 graph：sql_query → script(Stub) → http(手填) → 完成
 *   2. wait_webhook 场景：跑到 wait_webhook → 直接调 resumeDryRunFromWebhook → resume → 完成
 *   3. 失败场景：sql_query 缺 sqlTemplate → snapshot status=failed + SSE done
 *
 * 特别说明：
 *   - fastify-inject 不支持 SSE 流式响应，必须用 app.listen + 真 fetch
 *   - wait_webhook 场景：/webhook/generic 未在 admin test app 注册，
 *     直接调用 resumeDryRunFromWebhook() 模拟外部 POST 到达
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { resetTestDb } from '../helpers/db.js'
import { buildAdminTestApp } from '../helpers/admin-app.js'
import { registerDryRunRoutes } from '../../admin/routes/dryrun.js'
import { runDryRun, resumeDryRunFromWebhook } from '../../pipeline/dryrun-runner.js'
import { resetCheckpointerForTesting } from '../../pipeline/graph-runtime.js'
import { getPool } from '../../db/client.js'
import type { FastifyInstance } from 'fastify'
import type { AddressInfo } from 'node:net'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SseChunk {
  type: string
  [k: string]: unknown
}

/**
 * 异步 generator：从 ReadableStream 逐行解析 SSE 事件。
 * 每次 yield 一个已解析的 { type, data, ...data-fields } 对象。
 */
async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SseChunk> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buf = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })

      // SSE 事件以两个换行分隔
      const events = buf.split('\n\n')
      buf = events.pop() ?? ''

      for (const ev of events) {
        let type = 'message'
        let dataStr = ''
        for (const line of ev.split('\n')) {
          if (line.startsWith('event:')) type = line.slice(6).trim()
          else if (line.startsWith('data:')) dataStr += line.slice(5).trim()
        }
        if (!dataStr) continue
        try {
          const parsed = JSON.parse(dataStr) as SseChunk
          // event type field takes precedence over the type in JSON data
          yield { ...parsed, type: type !== 'message' ? type : (parsed.type ?? type) }
        } catch {
          // skip unparseable chunks
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

async function buildApp(): Promise<FastifyInstance> {
  return buildAdminTestApp(async (app) => {
    await registerDryRunRoutes(app)
  })
}

async function seedPipeline(graph: unknown): Promise<number> {
  const r = await getPool().query(
    `INSERT INTO test_pipelines (name, graph) VALUES ('e2e-test', $1::jsonb) RETURNING id`,
    [JSON.stringify(graph)],
  )
  return r.rows[0].id as number
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dryrun e2e', () => {
  let app: FastifyInstance | null = null

  beforeEach(async () => {
    await resetTestDb()
    // PostgresSaver checkpointer is a singleton; after resetTestDb drops + recreates
    // the public schema, the checkpoint tables are gone. Reset the singleton so
    // the next runDryRun call will call saver.setup() again to recreate them.
    resetCheckpointerForTesting()
    // Advisory locks in PostgreSQL are connection-scoped. The pg pool may acquire
    // a lock on connection A but release it on connection B, leaving A's lock intact.
    // After resetTestDb, pipeline IDs restart from 1, so the stale lock from the
    // previous test blocks the next test. Drain all pool connections by temporarily
    // checking out each idle client and calling pg_advisory_unlock_all().
    const pool = getPool()
    const poolSize = (pool as unknown as { idleCount: number }).idleCount ?? 5
    const clients = []
    for (let i = 0; i < poolSize + 3; i++) {
      try {
        const c = await pool.connect()
        clients.push(c)
        await c.query('SELECT pg_advisory_unlock_all()')
      } catch {
        break
      }
    }
    for (const c of clients) c.release()
  })

  afterEach(async () => {
    if (app) {
      await app.close()
      app = null
    }
  })

  /**
   * Case 1: 简单 graph — sql_query → script(Stub) → http(手填) → 完成
   *
   * 验证：
   *   - 收到 decision-needed for script → POST decide stub → 继续
   *   - 收到 decision-needed for http → POST decide manual → 继续
   *   - 最终 SSE 收到 done
   *   - DB snapshot 有 q(real) / s(stub) / h(manual)
   */
  it('简单 graph：sql_query → script(Stub) → http(手填) 全程', async () => {
    const graph = {
      nodes: [
        {
          id: 'q', name: 'q', stageType: 'sql_query',
          params: { sqlTemplate: 'SELECT 1' },
          position: { x: 0, y: 0 }, targetRoles: [], parallel: false,
          timeoutSeconds: 60, retryCount: 0, onFailure: 'stop',
        },
        {
          id: 's', name: 's', stageType: 'script',
          params: {}, script: 'echo 1', targetRoles: ['app'],
          position: { x: 0, y: 0 }, parallel: false,
          timeoutSeconds: 60, retryCount: 0, onFailure: 'stop',
        },
        {
          id: 'h', name: 'h', stageType: 'http',
          params: { url: 'http://example.com' },
          position: { x: 0, y: 0 }, targetRoles: [], parallel: false,
          timeoutSeconds: 60, retryCount: 0, onFailure: 'stop',
        },
      ],
      edges: [
        { id: 'e1', source: 'q', target: 's' },
        { id: 'e2', source: 's', target: 'h' },
      ],
    }

    const pid = await seedPipeline(graph)
    app = await buildApp()
    await app.listen({ port: 0 })
    const port = (app.server.address() as AddressInfo).port
    const baseUrl = `http://localhost:${port}`

    // Start SSE stream via real fetch (fastify-inject doesn't support SSE)
    const sseResp = await fetch(
      `${baseUrl}/test-pipelines/${pid}/dry-run/run-to/*`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          triggerParams: {},
          triggerType: 'manual',
          triggeredBy: 'e2e-test',
        }),
      },
    )
    expect(sseResp.status).toBe(200)
    expect(sseResp.headers.get('content-type')).toContain('text/event-stream')
    expect(sseResp.body).toBeTruthy()

    // Consume SSE stream and handle decisions inline
    const seenTypes: string[] = []
    let sessionId: string | null = null

    // Collect all chunks; for decision-needed, fire decide in background
    // (non-blocking to avoid deadlock — fetch /decide while still reading SSE)
    const collectedChunks: SseChunk[] = []
    const decidedNodes = new Set<string>()

    for await (const chunk of parseSseStream(sseResp.body!)) {
      collectedChunks.push(chunk)
      seenTypes.push(chunk.type)

      // Capture sessionId from started chunk
      if (chunk.type === 'started' && typeof chunk.sessionId === 'string') {
        sessionId = chunk.sessionId
      }

      // Handle decision-needed inline (non-blocking)
      if (chunk.type === 'decision-needed' && sessionId) {
        const nodeId = chunk.nodeId as string
        if (!decidedNodes.has(nodeId)) {
          decidedNodes.add(nodeId)
          const decision = nodeId === 's'
            ? { nodeId, decision: 'stub' }
            : { nodeId, decision: 'manual', manualOutput: { result: 'ok' } }

          // Fire decide in next microtask to let the waiter register
          Promise.resolve().then(() =>
            fetch(`${baseUrl}/test-pipelines/${pid}/dry-run/sessions/${sessionId}/decide`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(decision),
            }).catch(() => {/* ignore decide errors in background */})
          ).catch(() => {})
        }
      }

      if (chunk.type === 'done') break
    }

    // Assert SSE event sequence
    expect(seenTypes).toContain('started')
    expect(seenTypes).toContain('decision-needed')
    expect(seenTypes).toContain('snapshot')
    expect(seenTypes).toContain('done')

    // Assert DB snapshots
    const { rows } = await getPool().query(
      `SELECT node_id, status, source FROM pipeline_dryrun_snapshots WHERE pipeline_id=$1 ORDER BY node_id`,
      [pid],
    )
    const byNodeId = Object.fromEntries(rows.map(r => [r.node_id as string, r]))
    expect(byNodeId['q']).toBeDefined()
    expect(byNodeId['q'].status).toBe('success')
    expect(byNodeId['q'].source).toBe('real')
    expect(byNodeId['s']).toBeDefined()
    expect(byNodeId['s'].source).toBe('stub')
    expect(byNodeId['h']).toBeDefined()
    expect(byNodeId['h'].source).toBe('manual')
  }, 30_000)

  /**
   * Case 2: wait_webhook 场景
   *
   * graph: sql_query → wait_webhook
   *
   * 当 runDryRun 暂停在 wait_webhook（SSE 推出 waiting-external），
   * 直接调用 resumeDryRunFromWebhook() 模拟外部 POST 到达，
   * graph resume，最终 SSE 收到 done。
   *
   * 实现说明：
   *   - 直接调用 runDryRun()（跳过 HTTP route），因为 route 未暴露 baseUrl 参数。
   *   - baseUrl 设为真实监听地址（虽然本测试不真的走 /webhook/generic，
   *     但 buildDryRunWebhookUrl 需要合法 URL 才能构造 hint）。
   *   - resumeDryRunFromWebhook() 直接触发内存等待队列（模拟外部 POST）。
   */
  it('wait_webhook 场景：暂停 → resume → 完成', async () => {
    const graph = {
      nodes: [
        {
          id: 'q', name: 'q', stageType: 'sql_query',
          params: { sqlTemplate: 'SELECT 1' },
          position: { x: 0, y: 0 }, targetRoles: [], parallel: false,
          timeoutSeconds: 60, retryCount: 0, onFailure: 'stop',
        },
        {
          id: 'w', name: 'w', stageType: 'wait_webhook',
          webhookTag: 'e2e-done',
          params: {},
          position: { x: 0, y: 0 }, targetRoles: [], parallel: false,
          timeoutSeconds: 60, retryCount: 0, onFailure: 'stop',
        },
      ],
      edges: [
        { id: 'e1', source: 'q', target: 'w' },
      ],
    }

    const pid = await seedPipeline(graph)

    const chunks: Array<{ type: string; [k: string]: unknown }> = []
    const sessionId = `wh-test-${Date.now()}`

    // Run the dry-run directly (not via HTTP route) so we can pass baseUrl.
    // This is the same code path exercised by the admin route internally.
    const runPromise = runDryRun({
      sessionId,
      pipelineId: pid,
      targetNodeId: '*',
      triggerParams: {},
      triggerType: 'manual',
      triggeredBy: 'e2e-test',
      baseUrl: 'http://localhost:9999', // dummy baseUrl for URL construction only
      ssePush: (chunk) => {
        chunks.push(chunk)
        // When we see waiting-external, fire resumeDryRunFromWebhook in a microtask
        // to let the waiter register before we dispatch.
        if (chunk.type === 'waiting-external') {
          Promise.resolve().then(() => {
            resumeDryRunFromWebhook(sessionId, { status: 'ok', ref: 'main' })
          }).catch(() => {})
        }
      },
    })

    await runPromise

    const types = chunks.map(c => c.type)
    expect(types).toContain('started')
    expect(types).toContain('waiting-external')
    expect(types).toContain('done')

    // Verify the waiting-external chunk had a webhookUrl (hint for the frontend)
    const waitingChunk = chunks.find(c => c.type === 'waiting-external')
    expect(waitingChunk).toBeDefined()
    expect(typeof waitingChunk!.webhookUrl).toBe('string')
    expect(waitingChunk!.webhookTag).toBe('e2e-done')

    // sql_query snapshot should be saved
    const { rows } = await getPool().query(
      `SELECT node_id, status FROM pipeline_dryrun_snapshots WHERE pipeline_id=$1`,
      [pid],
    )
    const nodeIds = rows.map(r => r.node_id as string)
    expect(nodeIds).toContain('q')
  }, 30_000)

  /**
   * Case 3: 节点失败 — sql_query 缺 sqlTemplate → snapshot status=failed + SSE done
   *
   * sql_query executor 在 params.sqlTemplate 为空时返回 status='failed'。
   * dryrun-runner 的 wrapWithSnapshot 应该 recordSnapshot(status='failed')
   * 并推出 snapshot(status=failed) SSE，然后 graph 停止，SSE 收到 done。
   */
  it('节点失败：sql_query 缺 sqlTemplate → snapshot status=failed + done', async () => {
    const graph = {
      nodes: [
        {
          id: 'q', name: 'q', stageType: 'sql_query',
          params: {/* 故意不填 sqlTemplate */},
          position: { x: 0, y: 0 }, targetRoles: [], parallel: false,
          timeoutSeconds: 60, retryCount: 0, onFailure: 'stop',
        },
      ],
      edges: [],
    }

    const pid = await seedPipeline(graph)
    app = await buildApp()
    await app.listen({ port: 0 })
    const port = (app.server.address() as AddressInfo).port
    const baseUrl = `http://localhost:${port}`

    const sseResp = await fetch(
      `${baseUrl}/test-pipelines/${pid}/dry-run/run-to/*`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          triggerParams: {},
          triggerType: 'manual',
          triggeredBy: 'e2e-test',
        }),
      },
    )
    expect(sseResp.status).toBe(200)
    expect(sseResp.body).toBeTruthy()

    const seenTypes: string[] = []
    const snapshotChunks: SseChunk[] = []

    for await (const chunk of parseSseStream(sseResp.body!)) {
      seenTypes.push(chunk.type)
      if (chunk.type === 'snapshot') snapshotChunks.push(chunk)
      if (chunk.type === 'done' || chunk.type === 'error') break
    }

    // Should see either done or error (graph stops on failure)
    expect(seenTypes.some(t => t === 'done' || t === 'error')).toBe(true)

    // DB snapshot should have status='failed' for node 'q'
    const { rows } = await getPool().query(
      `SELECT node_id, status FROM pipeline_dryrun_snapshots WHERE pipeline_id=$1`,
      [pid],
    )
    expect(rows.length).toBeGreaterThan(0)
    const qRow = rows.find(r => (r.node_id as string) === 'q')
    expect(qRow).toBeDefined()
    expect(qRow!.status).toBe('failed')
  }, 30_000)
})
