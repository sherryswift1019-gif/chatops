import type { FastifyInstance } from 'fastify'
import { randomUUID, createHash } from 'node:crypto'
import { runDryRun, decideSideEffect } from '../../pipeline/dryrun-runner.js'
import { listSnapshots, deleteSnapshot, deleteAllSnapshots } from '../../db/repositories/dryrun-snapshots.js'
import { getTestPipelineById } from '../../db/repositories/test-pipelines.js'
import { computeUpstreamHash } from '../../pipeline/dryrun-hash.js'
import { getPool } from '../../db/client.js'
import type { PipelineGraph } from '../../pipeline/types.js'

export async function registerDryRunRoutes(app: FastifyInstance): Promise<void> {
  // 1. 历史回放数据源
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/test-pipelines/:id/recent-trigger-params',
    async (req, reply) => {
      const limit = Math.min(Number(req.query.limit ?? 20), 50)
      const { rows } = await getPool().query(
        `SELECT id, trigger_type, triggered_by, trigger_params, started_at, status
         FROM test_runs
         WHERE pipeline_id=$1
         ORDER BY started_at DESC LIMIT $2`,
        [Number(req.params.id), limit])
      return reply.send(rows.map(r => ({
        runId: r.id,
        triggerType: r.trigger_type,
        triggeredBy: r.triggered_by,
        triggerParams: r.trigger_params,
        startedAt: r.started_at,
        status: r.status,
      })))
    })

  // 2. 拉所有 snapshot（含 stale 标）
  app.get<{ Params: { id: string } }>(
    '/test-pipelines/:id/dry-run/snapshots',
    async (req, reply) => {
      const pid = Number(req.params.id)
      const pipeline = await getTestPipelineById(pid)
      if (!pipeline) return reply.status(404).send({ error: 'pipeline not found' })
      const graph = (pipeline.graph ?? null) as PipelineGraph | null
      const snapshots = await listSnapshots(pid)
      const enriched = snapshots.map(s => {
        const stale = graph
          ? computeUpstreamHash(graph, s.nodeId) !== s.upstreamParamsHash
          : true
        return { ...s, stale }
      })
      return reply.send(enriched)
    })

  // 3. 清所有 snapshot
  app.delete<{ Params: { id: string } }>(
    '/test-pipelines/:id/dry-run/snapshots',
    async (req, reply) => {
      await deleteAllSnapshots(Number(req.params.id))
      return reply.status(204).send()
    })

  // 4. 清单个 snapshot
  app.delete<{ Params: { id: string; nodeId: string } }>(
    '/test-pipelines/:id/dry-run/snapshots/:nodeId',
    async (req, reply) => {
      await deleteSnapshot(Number(req.params.id), req.params.nodeId)
      return reply.status(204).send()
    })

  // 5. 启动 SSE 试运行
  app.post<{
    Params: { id: string; nodeId: string }
    Body: { graphHash?: string; triggerParams: Record<string, unknown>; triggerType: string; triggeredBy: string }
  }>('/test-pipelines/:id/dry-run/run-to/:nodeId', async (req, reply) => {
    const pid = Number(req.params.id)
    const pipeline = await getTestPipelineById(pid)
    if (!pipeline) return reply.status(404).send({ error: 'pipeline not found' })

    // graph dirty check
    if (req.body.graphHash) {
      const dbHash = createHash('sha256').update(JSON.stringify(pipeline.graph ?? {})).digest('hex')
      if (req.body.graphHash !== dbHash) {
        return reply.status(400).send({ error: 'graph dirty: 请先保存再试运行' })
      }
    }

    const sessionId = randomUUID()
    reply.raw.setHeader('Content-Type', 'text/event-stream')
    reply.raw.setHeader('Cache-Control', 'no-cache')
    reply.raw.setHeader('Connection', 'keep-alive')
    reply.raw.flushHeaders()

    const ssePush = (chunk: { type: string; [k: string]: unknown }) => {
      reply.raw.write(`event: ${chunk.type}\n`)
      reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`)
    }

    try {
      await runDryRun({
        sessionId, pipelineId: pid, targetNodeId: req.params.nodeId,
        triggerParams: req.body.triggerParams, triggerType: req.body.triggerType,
        triggeredBy: req.body.triggeredBy, ssePush,
      })
    } catch (e) {
      ssePush({ type: 'error', error: e instanceof Error ? e.message : String(e), fatal: true })
    } finally {
      reply.raw.end()
    }
  })

  // 6. 提交副作用决策
  app.post<{
    Params: { id: string; sessionId: string }
    Body: { nodeId: string; decision: 'real' | 'stub' | 'manual'; manualOutput?: Record<string, unknown>; remember?: boolean }
  }>('/test-pipelines/:id/dry-run/sessions/:sessionId/decide', async (req, reply) => {
    try {
      await decideSideEffect(req.params.sessionId, req.body.nodeId, {
        decision: req.body.decision,
        output: req.body.manualOutput,
        remember: req.body.remember,
      })
      return reply.status(204).send()
    } catch (e) {
      return reply.status(404).send({ error: e instanceof Error ? e.message : String(e) })
    }
  })
}
