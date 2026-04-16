import type { FastifyInstance } from 'fastify'
import { listTestRuns, getTestRunById } from '../../db/repositories/test-runs.js'
import { getDingTalkUserById, getDingTalkUsersByIds } from '../../db/repositories/dingtalk-users.js'
import { runPipeline } from '../../pipeline/executor.js'
import { readFile, stat } from 'fs/promises'
import { join } from 'path'
import { createReadStream } from 'fs'

const DATA_DIR = process.env.TEST_DATA_DIR || '/data/chatops/test-runs'

export async function registerTestRunRoutes(app: FastifyInstance): Promise<void> {
  // List runs
  app.get<{ Querystring: { pipeline_id?: string; page?: string; page_size?: string } }>('/test-runs', async (req, reply) => {
    const pipelineId = req.query.pipeline_id ? Number(req.query.pipeline_id) : undefined
    const page = req.query.page ? Number(req.query.page) : undefined
    const pageSize = req.query.page_size ? Number(req.query.page_size) : undefined
    const result = await listTestRuns({ pipelineId, page, pageSize })
    const userIds = [...new Set(result.items.map(r => r.triggeredBy).filter(Boolean))]
    const userMap = await getDingTalkUsersByIds(userIds)
    return reply.send({
      items: result.items.map(r => {
        const u = userMap.get(r.triggeredBy)
        return { ...r, triggeredByName: u?.name, triggeredByAvatar: u?.avatar }
      }),
      total: result.total,
    })
  })

  // Get run details
  app.get<{ Params: { id: string } }>('/test-runs/:id', async (req, reply) => {
    const run = await getTestRunById(Number(req.params.id))
    if (!run) return reply.status(404).send({ error: 'not found' })
    const u = await getDingTalkUserById(run.triggeredBy).catch(() => null)
    return reply.send({ ...run, triggeredByName: u?.name, triggeredByAvatar: u?.avatar })
  })

  // Trigger a pipeline run
  app.post<{ Body: {
    pipelineId: number
    servers: Record<string, string[]>
    triggeredBy?: string
  } }>('/test-runs', async (req, reply) => {
    const { pipelineId, servers, triggeredBy } = req.body
    if (!pipelineId || !servers) {
      return reply.status(400).send({ error: 'pipelineId and servers required' })
    }
    // Run pipeline in background — don't await
    const runId = await runPipeline(pipelineId, servers, 'api', triggeredBy ?? 'api')
    return reply.status(201).send({ runId, message: 'Pipeline started' })
  })

  // View HTML report in browser
  app.get<{ Params: { id: string } }>('/test-runs/:id/report', async (req, reply) => {
    const run = await getTestRunById(Number(req.params.id))
    if (!run) return reply.status(404).send({ error: 'not found' })
    const reportPath = join(run.reportPath || join(DATA_DIR, String(run.id)), 'report.html')
    try {
      const html = await readFile(reportPath, 'utf8')
      return reply.type('text/html').send(html)
    } catch {
      return reply.status(404).send({ error: 'Report not yet generated' })
    }
  })

  // Download ZIP archive
  app.get<{ Params: { id: string } }>('/test-runs/:id/report/download', async (req, reply) => {
    const run = await getTestRunById(Number(req.params.id))
    if (!run) return reply.status(404).send({ error: 'not found' })
    const logDir = run.reportPath || join(DATA_DIR, String(run.id))
    const zipPath = join(logDir, `test-run-${run.id}.zip`)
    try {
      await stat(zipPath)
      const stream = createReadStream(zipPath)
      return reply
        .type('application/zip')
        .header('Content-Disposition', `attachment; filename="test-run-${run.id}.zip"`)
        .send(stream)
    } catch {
      return reply.status(404).send({ error: 'ZIP archive not yet generated' })
    }
  })
}
