import type { FastifyInstance } from 'fastify'
import { Command } from '@langchain/langgraph'
import { listTestRuns, getTestRunById } from '../../db/repositories/test-runs.js'
import { getDingTalkUserById, getDingTalkUsersByIds } from '../../db/repositories/dingtalk-users.js'
import { runPipeline, manualTrigger, apiTrigger } from '../../pipeline/executor.js'
import { getPendingInterrupt, resumeRun } from '../../pipeline/graph-runner.js'
import { APPROVAL_INTERRUPT, WEBHOOK_INTERRUPT } from '../../pipeline/graph-builder.js'
import { autoResolveServersByRole } from '../../pipeline/server-resolver.js'
import { readFile, stat } from 'fs/promises'
import { join } from 'path'
import { createReadStream, watch as fsWatch, type FSWatcher } from 'fs'
import { resolveDataDir } from '../../pipeline/data-dir.js'

const DATA_DIR = resolveDataDir()

/**
 * 把 stage 日志文件名标准化。两种 kind：
 *   - script:     SSH 脚本 stage 的 stdout/stderr 行
 *   - capability: capability stage 内 LLM Agent 的对话 trace
 * NN = stageIndex+1，零填充两位（与 executor-hooks.ts / diagnose-repair-handler.ts 对齐）。
 */
function stageLogPath(runId: number, stageIndex: number, kind: 'script' | 'capability'): string {
  const fileName = `${String(stageIndex + 1).padStart(2, '0')}-${kind}.log`
  return join(resolveDataDir(), String(runId), fileName)
}

/**
 * 探测 stage 当前可用日志文件。优先 capability（agent trace 信息更密），其次 script。
 * 都不存在返回 null。
 */
async function probeStageLog(
  runId: number,
  stageIndex: number,
): Promise<{ filePath: string; fileType: 'script' | 'capability'; size: number } | null> {
  const capPath = stageLogPath(runId, stageIndex, 'capability')
  const scriptPath = stageLogPath(runId, stageIndex, 'script')
  try {
    const s = await stat(capPath)
    return { filePath: capPath, fileType: 'capability', size: s.size }
  } catch { /* fallthrough */ }
  try {
    const s = await stat(scriptPath)
    return { filePath: scriptPath, fileType: 'script', size: s.size }
  } catch { /* fallthrough */ }
  return null
}

/** stage 是否进入终态（不会再有日志输出）。 */
function isStageTerminal(status: string | undefined): boolean {
  return status === 'success' || status === 'failed' || status === 'skipped'
}

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
    params?: Record<string, unknown>
  } }>('/test-runs', async (req, reply) => {
    const { pipelineId, servers, triggeredBy, triggerType, runtimeVars, params } = req.body
    if (!pipelineId || !servers) {
      return reply.status(400).send({ error: 'pipelineId and servers required' })
    }
    const effectiveType: 'manual' | 'api' = triggerType === 'manual' ? 'manual' : 'api'
    const sessionUser = req.session.get('username')
    const effectiveUser = effectiveType === 'manual'
      ? (sessionUser ?? 'admin')
      : (triggeredBy ?? sessionUser ?? 'api')

    // Auto-resolve servers by role when none explicitly provided
    let effectiveServers = servers
    if (Object.keys(servers).length === 0) {
      const byRole = await autoResolveServersByRole()
      if (Object.keys(byRole).length > 0) effectiveServers = byRole
    }

    try {
      const trigger = effectiveType === 'manual'
        ? manualTrigger({ triggeredBy: effectiveUser, params: params ?? {} })
        : apiTrigger({ triggeredBy: effectiveUser, params: params ?? {} })
      const runId = await runPipeline(pipelineId, effectiveServers, trigger, runtimeVars ?? {})
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

  // ─── Stage 日志（一次性 + SSE 实时） ──────────────────────────────────────────
  //
  // 落盘约定：<DATA_DIR>/<runId>/{NN}-script.log  和  {NN}-capability.log
  //   - NN = stageIndex+1，零填充两位
  //   - script  来自 executor-hooks.ts:runScriptOnServers（SSH stage）
  //   - capability 来自 diagnose-repair-handler.ts:writeLogLine（capability stage）
  //
  // 优先级：capability > script（agent trace 比 ssh 输出信息密度更高）。
  // 两个文件都不存在 → 一次性 endpoint 404；SSE endpoint 返回 hello{fileType:null}
  // 后等文件出现，stage 终态后发 done 关闭。
  app.get<{ Params: { runId: string; stageIndex: string } }>(
    '/test-runs/:runId/stage/:stageIndex/log',
    async (req, reply) => {
      const runId = Number(req.params.runId)
      const stageIndex = Number(req.params.stageIndex)
      if (!Number.isFinite(runId) || runId <= 0 || !Number.isFinite(stageIndex) || stageIndex < 0) {
        return reply.status(400).send({ error: 'invalid runId or stageIndex' })
      }
      const run = await getTestRunById(runId)
      if (!run) return reply.status(404).send({ error: 'run not found' })
      if (stageIndex >= run.stageResults.length) {
        return reply.status(400).send({ error: 'stageIndex out of range' })
      }
      const probed = await probeStageLog(runId, stageIndex)
      if (!probed) {
        return reply.status(404).send({ error: 'log not found', fileType: null })
      }
      const content = await readFile(probed.filePath, 'utf8').catch(() => '')
      return reply.send({
        runId,
        stageIndex,
        filePath: probed.filePath,
        fileType: probed.fileType,
        content,
      })
    },
  )

  // SSE：hello → snapshot（已存在内容） → append*（增量） → done|error，最终 close。
  // 文件不存在时也立刻 hello{fileType:null}，前端先显示「等待中」，后端
  // poll 500ms 直到文件出现，再发 snapshot + 转 fs.watch 增量。stage 入终态
  // 后冲 1 次最终 read 再 done，避免漏掉刚写入的最后几字节。
  app.get<{ Params: { runId: string; stageIndex: string } }>(
    '/test-runs/:runId/stage/:stageIndex/log/stream',
    async (req, reply) => {
      const runId = Number(req.params.runId)
      const stageIndex = Number(req.params.stageIndex)
      if (!Number.isFinite(runId) || runId <= 0 || !Number.isFinite(stageIndex) || stageIndex < 0) {
        return reply.status(400).send({ error: 'invalid runId or stageIndex' })
      }
      const initialRun = await getTestRunById(runId)
      if (!initialRun) return reply.status(404).send({ error: 'run not found' })
      if (stageIndex >= initialRun.stageResults.length) {
        return reply.status(400).send({ error: 'stageIndex out of range' })
      }

      reply.raw.setHeader('Content-Type', 'text/event-stream')
      reply.raw.setHeader('Cache-Control', 'no-cache')
      reply.raw.setHeader('Connection', 'keep-alive')
      reply.raw.flushHeaders()

      const ssePush = (event: string, data: Record<string, unknown>): void => {
        try {
          reply.raw.write(`event: ${event}\n`)
          reply.raw.write(`data: ${JSON.stringify(data)}\n\n`)
        } catch { /* connection closed; cleanup runs in finally */ }
      }

      let cursor = 0
      let activeFile: string | null = null
      let activeKind: 'script' | 'capability' | null = null
      let watcher: FSWatcher | null = null
      let pollTimer: NodeJS.Timeout | null = null
      let terminalTimer: NodeJS.Timeout | null = null
      let closed = false

      const cleanup = (): void => {
        if (closed) return
        closed = true
        if (watcher) { try { watcher.close() } catch { /* ignore */ } watcher = null }
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
        if (terminalTimer) { clearInterval(terminalTimer); terminalTimer = null }
        try { reply.raw.end() } catch { /* ignore */ }
      }

      // 文件已就位，把 cursor 之后的新增字节推为一段 append。
      const flushAppend = async (): Promise<void> => {
        if (!activeFile) return
        try {
          const s = await stat(activeFile)
          if (s.size <= cursor) return
          const chunks: Buffer[] = []
          await new Promise<void>((resolve, reject) => {
            const rs = createReadStream(activeFile!, { start: cursor, end: s.size - 1 })
            rs.on('data', (b) => chunks.push(b as Buffer))
            rs.on('end', () => resolve())
            rs.on('error', reject)
          })
          cursor = s.size
          const text = Buffer.concat(chunks).toString('utf8')
          if (text.length > 0) {
            ssePush('append', { content: text, size: cursor })
          }
        } catch { /* file vanished mid-flight; ignore */ }
      }

      const attachWatcher = (filePath: string, kind: 'script' | 'capability'): void => {
        activeFile = filePath
        activeKind = kind
        try {
          watcher = fsWatch(filePath, { persistent: false }, () => {
            void flushAppend()
          })
        } catch {
          // 平台不支持 / 文件刚被删——退化到轮询
          pollTimer = setInterval(() => { void flushAppend() }, 1000)
        }
      }

      // 终态探测循环：每秒拉一次 run 状态，stage 入终态后冲一次 final flush 再 done。
      const startTerminalWatch = (): void => {
        terminalTimer = setInterval(() => {
          void (async () => {
            const r = await getTestRunById(runId).catch(() => null)
            if (!r) return
            const stage = r.stageResults[stageIndex]
            if (isStageTerminal(stage?.status)) {
              await flushAppend()
              ssePush('done', { status: stage?.status ?? 'success' })
              cleanup()
            }
          })()
        }, 1000)
      }

      try {
        // 1) 初始探测
        const probed = await probeStageLog(runId, stageIndex)
        ssePush('hello', {
          runId,
          stageIndex,
          fileType: probed?.fileType ?? null,
          filePath: probed?.filePath ?? null,
        })

        if (probed) {
          // 2a) 文件已存在 → 先发 snapshot，再挂 watcher
          const content = await readFile(probed.filePath, 'utf8').catch(() => '')
          cursor = probed.size
          ssePush('snapshot', { content, fileType: probed.fileType, size: cursor })

          // 已经是终态？直接 done。
          const stage = initialRun.stageResults[stageIndex]
          if (isStageTerminal(stage?.status)) {
            ssePush('done', { status: stage?.status ?? 'success' })
            cleanup()
            return reply
          }
          attachWatcher(probed.filePath, probed.fileType)
          startTerminalWatch()
        } else {
          // 2b) 文件还没出现 → 轮询 500ms 等出现
          pollTimer = setInterval(() => {
            void (async () => {
              if (activeFile) return
              const p = await probeStageLog(runId, stageIndex)
              if (p) {
                const content = await readFile(p.filePath, 'utf8').catch(() => '')
                cursor = p.size
                ssePush('snapshot', { content, fileType: p.fileType, size: cursor })
                if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
                attachWatcher(p.filePath, p.fileType)
              }
            })()
          }, 500)
          startTerminalWatch()
        }

        // 客户端断开 → 清理
        req.raw.on('close', cleanup)
      } catch (err) {
        ssePush('error', { error: err instanceof Error ? err.message : String(err) })
        cleanup()
      }
      void activeKind  // suppress unused
      return reply
    },
  )
}
