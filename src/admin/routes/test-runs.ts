import type { FastifyInstance } from 'fastify'
import { Command } from '@langchain/langgraph'
import { listTestRuns, getTestRunById } from '../../db/repositories/test-runs.js'
import { getDingTalkUserById, getDingTalkUsersByIds } from '../../db/repositories/dingtalk-users.js'
import { runPipeline } from '../../pipeline/executor.js'
import { getPendingInterrupt, resumeRun } from '../../pipeline/graph-runner.js'
import { APPROVAL_INTERRUPT, WEBHOOK_INTERRUPT } from '../../pipeline/graph-builder.js'
import { readFile, stat } from 'fs/promises'
import { join } from 'path'
import { createReadStream } from 'fs'

const DATA_DIR = process.env.TEST_DATA_DIR || '/data/chatops/test-runs'

interface ResumeBody {
  approval?: 'approved' | 'rejected' | 'timeout'
  webhookData?: unknown
  webhookTimeout?: boolean
}

export async function registerTestRunRoutes(app: FastifyInstance): Promise<void> {
  // List runs
  app.get('/test-runs', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          pipeline_id: { type: 'integer' },
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        },
      },
    },
  }, async (req, reply) => {
    const { pipeline_id, page, limit } = req.query as { pipeline_id?: number; page: number; limit: number }
    const result = await listTestRuns(pipeline_id ?? null, page, limit)
    const userIds = [...new Set(result.data.map(r => r.triggeredBy).filter(Boolean))]
    const userMap = await getDingTalkUsersByIds(userIds)
    return reply.send({
      data: result.data.map(r => {
        const u = userMap.get(r.triggeredBy)
        return { ...r, triggeredByName: u?.name, triggeredByAvatar: u?.avatar }
      }),
      total: result.total,
      page,
      limit,
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
    triggerType?: 'manual' | 'api'
    runtimeVars?: Record<string, string>
  } }>('/test-runs', async (req, reply) => {
    const { pipelineId, servers, triggeredBy, triggerType, runtimeVars } = req.body
    if (!pipelineId || !servers) {
      return reply.status(400).send({ error: 'pipelineId and servers required' })
    }
    const effectiveType: 'manual' | 'api' = triggerType === 'manual' ? 'manual' : 'api'
    const sessionUser = req.session.get('username')
    // Manual triggers must be attributed to the logged-in user — never trust body.triggeredBy.
    // API triggers may override triggeredBy (e.g. CI systems identifying themselves);
    // fall back to session, then a generic 'api' marker.
    const effectiveUser = effectiveType === 'manual'
      ? (sessionUser ?? 'admin')
      : (triggeredBy ?? sessionUser ?? 'api')
    try {
      const runId = await runPipeline(pipelineId, servers, effectiveType, effectiveUser, runtimeVars ?? {})
      return reply.status(201).send({ runId, message: 'Pipeline started' })
    } catch (e) {
      return reply.status(400).send({ error: (e as Error).message })
    }
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

  // Manually resume a run paused on an interrupt. Typical use: DingTalk card
  // never got a reply / webhook never arrived, operator decides from UI.
  //
  // Scope: only runs currently suspended on an interrupt. "Failed retrigger"
  // (graph already at END) is a separate concern — handle via POST /test-runs.
  app.post<{ Params: { id: string }; Body: ResumeBody }>('/test-runs/:id/resume', async (req, reply) => {
    const runId = Number(req.params.id)
    if (!Number.isFinite(runId) || runId <= 0) {
      return reply.status(400).send({ error: 'invalid run id' })
    }
    const run = await getTestRunById(runId)
    if (!run) return reply.status(404).send({ error: 'run not found' })
    // A run that has never started has no graph state yet — separate message
    // so the UI can show "not started" instead of a generic conflict.
    if (run.status === 'pending') {
      return reply.status(409).send({ error: 'run not started yet' })
    }
    // A finished run cannot be resumed — the graph is at END and state is frozen.
    if (run.status === 'success' || run.status === 'failed' || run.status === 'cancelled') {
      return reply.status(409).send({ error: `run already ${run.status}` })
    }

    const pending = await getPendingInterrupt(runId)
    if (!pending) {
      return reply.status(409).send({ error: 'no pending interrupt to resume' })
    }

    const body = (req.body ?? {}) as ResumeBody
    const actor = req.session.get('username') ?? 'admin'

    if (pending.type === APPROVAL_INTERRUPT) {
      const decision = body.approval
      if (!decision || !['approved', 'rejected', 'timeout'].includes(decision)) {
        return reply.status(400).send({
          error: 'approval field required: approved | rejected | timeout',
        })
      }
      req.log.info(
        { runId, action: 'resume', interruptType: 'approval', decision, actor },
        'resume endpoint invoked',
      )
      // Fire-and-forget: resume drives the graph until the next interrupt or
      // END, which is unbounded. Returning 200 after dispatch only guarantees
      // the Command was accepted — operator must watch the run status page
      // for the actual outcome. Errors are logged; they cannot surface in
      // this HTTP response.
      void resumeRun(runId, new Command({ resume: decision })).catch((err) => {
        req.log.error({ err, runId }, 'resumeRun failed after admin resume')
      })
      return reply.send({ ok: true, resumed: true, interruptType: 'approval' })
    }

    if (pending.type === WEBHOOK_INTERRUPT) {
      const hasData = Object.prototype.hasOwnProperty.call(body, 'webhookData')
      const hasTimeout = body.webhookTimeout === true
      if (hasData === hasTimeout) {
        // Either both present or both missing — caller bug either way.
        return reply.status(400).send({
          error: 'exactly one of webhookData or webhookTimeout=true required',
        })
      }
      const payload: { timeout: true } | { data: unknown } = hasTimeout
        ? { timeout: true }
        : { data: body.webhookData }
      req.log.info(
        { runId, action: 'resume', interruptType: 'webhook', payload, actor },
        'resume endpoint invoked',
      )
      void resumeRun(runId, new Command({ resume: payload })).catch((err) => {
        req.log.error({ err, runId }, 'resumeRun failed after admin resume')
      })
      return reply.send({ ok: true, resumed: true, interruptType: 'webhook' })
    }

    // Shouldn't happen — getPendingInterrupt filters unknown types to null.
    return reply
      .status(500)
      .send({ error: `unknown interrupt type: ${String((pending as { type?: unknown }).type)}` })
  })
}
