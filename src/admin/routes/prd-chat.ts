import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'crypto'
import type { ClaudeRunner } from '../../agent/claude-runner.js'
import {
  appendChatMessage,
  createChatSession,
  getChatSessionByKey,
  linkChatSessionToPrd,
  listChatMessages,
  touchChatSession,
  updateChatSessionPorygonId,
} from '../../db/repositories/prd-chat.js'
import { getProductLineById } from '../../db/repositories/product-lines.js'
import { scanPendingReviewsByTaskId } from '../../agent/prd/prd-agent.js'

function buildReviewProgressContent(stage: string, ev: Record<string, unknown>): string {
  const prdId = Number(ev.prdId ?? 0)
  switch (stage) {
    case 'review_started':
      return `🔍 已进入自审（PRD #${prdId}）`
    case 'structure_failed': {
      const errors = Array.isArray(ev.errors) ? (ev.errors as string[]) : []
      return `❌ 结构校验失败（PRD #${prdId}）：${errors.slice(0, 3).join('；')}${errors.length > 3 ? ' …' : ''}`
    }
    case 'round_done': {
      const round = Number(ev.round ?? 0)
      const blockers = Number(ev.blockerCount ?? 0)
      const warnings = Number(ev.warningCount ?? 0)
      const infos = Number(ev.infoCount ?? 0)
      const rec = ev.recommendation as { action?: string; reason?: string } | undefined
      const recText = rec?.action ? `，建议：${rec.action}` : ''
      return `🧪 Round ${round} 自审完成（PRD #${prdId}）：${blockers} 条 blocker / ${warnings} 条 warning / ${infos} 条 info${recText}`
    }
    case 'repair_started': {
      const round = Number(ev.round ?? 0)
      const fixable = Number(ev.fixableCount ?? 0)
      return `🛠 Round ${round} 触发自动修复（PRD #${prdId}）：${fixable} 条可修复项`
    }
    case 'repair_done': {
      const round = Number(ev.round ?? 0)
      const ok = Boolean(ev.ok)
      const reason = typeof ev.reason === 'string' ? ev.reason : ''
      return ok
        ? `✅ Round ${round} 自动修复完成（PRD #${prdId}）`
        : `⚠️ Round ${round} 自动修复未执行（PRD #${prdId}）：${reason || 'unknown'}`
    }
    case 'review_finalized': {
      const round = Number(ev.round ?? 0)
      const finalStatus = String(ev.finalStatus ?? '')
      const rec = ev.recommendation as { action?: string; reason?: string } | undefined
      const recText = rec?.reason ? `，原因：${rec.reason}` : ''
      return finalStatus === 'draft'
        ? `🎉 PRD #${prdId} 自审通过，已进入 draft（Round ${round}）${recText}`
        : `🚧 PRD #${prdId} 仍有阻断项，需要人工处理（Round ${round}）${recText}`
    }
    case 'review_error':
      return `💥 PRD #${prdId} 自审异常：${String(ev.error ?? 'unknown')}`
    default:
      return `ℹ️ 自审进度：${stage}（PRD #${prdId}）`
  }
}

export async function registerPrdChatRoutes(
  app: FastifyInstance,
  opts: { runner: ClaudeRunner }
): Promise<void> {
  const { runner } = opts

  // 新建会话
  app.post('/prd-chat/sessions', async (req, reply) => {
    const body = req.body as { product_line_id?: number; prd_id?: number | null }
    const productLineId = Number(body.product_line_id)
    if (!productLineId) {
      return reply.status(400).send({ error: { code: 'INVALID_ARG', message: 'product_line_id required' } })
    }
    const pl = await getProductLineById(productLineId)
    if (!pl) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'product line not found' } })
    }

    const username = req.session.get('username') ?? 'admin'
    const sessionKey = randomUUID()
    const session = await createChatSession({
      sessionKey,
      productLineId,
      prdId: body.prd_id ?? null,
      createdBy: username,
    })
    return { data: session }
  })

  // 会话详情
  app.get('/prd-chat/sessions/:key', async (req, reply) => {
    const key = (req.params as { key: string }).key
    const s = await getChatSessionByKey(key)
    if (!s) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'session not found' } })
    return { data: s }
  })

  // 历史消息
  app.get('/prd-chat/sessions/:key/messages', async (req, reply) => {
    const key = (req.params as { key: string }).key
    const s = await getChatSessionByKey(key)
    if (!s) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'session not found' } })
    const rows = await listChatMessages(key)
    return { data: rows }
  })

  // SSE 流式对话
  app.get('/prd-chat/sessions/:key/stream', async (req, reply) => {
    const key = (req.params as { key: string }).key
    const q = req.query as { text?: string }
    const text = (q.text ?? '').trim()
    if (!text) {
      return reply.status(400).send({ error: { code: 'INVALID_ARG', message: 'text required' } })
    }

    const session = await getChatSessionByKey(key)
    if (!session) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'session not found' } })
    }

    const username = req.session.get('username') ?? 'admin'

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    const send = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    // heartbeat 避免代理断开
    const hb = setInterval(() => {
      reply.raw.write(`: ping\n\n`)
    }, 15000)

    let clientClosed = false
    req.raw.on('close', () => {
      clientClosed = true
      clearInterval(hb)
    })

    const runStartedAt = new Date()

    try {
      // 1. 持久化 user 消息
      const userMsg = await appendChatMessage({
        sessionKey: key,
        role: 'user',
        content: text,
      })
      send('user_msg', userMsg)

      // 2. 累积 assistant 文本并定期 flush 到 DB
      let currentAssistant: string[] = []
      const flushAssistant = async () => {
        const merged = currentAssistant.join('')
        if (merged.trim()) {
          await appendChatMessage({
            sessionKey: key,
            role: 'assistant',
            content: merged,
          })
        }
        currentAssistant = []
      }

      const taskId = `web-prd-${key}`
      let capturedPorygonId: string | undefined

      for await (const evt of runner.streamWebChat({
        prompt: text,
        context: {
          taskId,
          groupId: `web:${key}`,
          platform: 'web',
          initiatorId: username,
          initiatorRole: 'admin',
          productLineId: session.productLineId,
        },
        capabilityKey: 'create_prd',
        sessionKey: key,
        resumeSessionId: session.porygonSessionId ?? undefined,
        productLineId: session.productLineId,
      })) {
        if (clientClosed) break

        switch (evt.type) {
          case 'stream_chunk':
            currentAssistant.push(evt.text ?? '')
            send('stream_chunk', { text: evt.text ?? '' })
            break
          case 'assistant':
            // turnComplete：一轮 assistant 正文汇总完成 → flush 并清空缓冲
            if (evt.turnComplete) {
              await flushAssistant()
              send('assistant_done', {})
            }
            break
          case 'tool_use': {
            // 每次 tool_use 之前先 flush 前面的 assistant 文本
            await flushAssistant()
            const toolMsg = await appendChatMessage({
              sessionKey: key,
              role: 'tool_use',
              content: JSON.stringify(evt.input ?? {}),
              toolName: evt.toolName ?? null,
              toolUseId: evt.toolUseId ?? null,
            })
            send('tool_use', toolMsg)
            break
          }
          case 'tool_result': {
            const toolMsg = await appendChatMessage({
              sessionKey: key,
              role: 'tool_result',
              content: evt.output ?? '',
              toolName: evt.toolName ?? null,
              toolUseId: evt.toolUseId ?? null,
            })
            send('tool_result', toolMsg)
            break
          }
          case 'error': {
            await flushAssistant()
            const errMsg = await appendChatMessage({
              sessionKey: key,
              role: 'error',
              content: evt.error ?? 'unknown error',
            })
            send('error_msg', errMsg)
            break
          }
          case 'review_progress': {
            // 先 flush 前面的 assistant 文本，避免 bubble 顺序错乱
            await flushAssistant()
            const ev = (evt.reviewData ?? {}) as Record<string, unknown>
            const stage = String(evt.reviewStage ?? ev.stage ?? '')
            const prdId = Number(evt.prdId ?? ev.prdId ?? 0)
            const content = buildReviewProgressContent(stage, ev)
            const msg = await appendChatMessage({
              sessionKey: key,
              role: 'assistant',
              content,
              metadata: { kind: 'review_progress', stage, prdId, payload: ev },
            })
            send('review_progress', msg)
            break
          }
          case 'done':
            await flushAssistant()
            capturedPorygonId = evt.sessionId
            break
        }
      }

      // 3. 持久化 porygon sessionId（用于下次 resume）
      if (capturedPorygonId) {
        await updateChatSessionPorygonId(key, capturedPorygonId)
      } else {
        await touchChatSession(key)
      }

      // 4. 若本轮创建/更新了 PRD 且会话尚未绑定 prdId → 回填
      if (session.prdId == null) {
        const prdIds = await scanPendingReviewsByTaskId(taskId, runStartedAt)
        if (prdIds.length > 0) {
          await linkChatSessionToPrd(key, prdIds[0])
          send('prd_linked', { prdId: prdIds[0] })
        }
      }

      send('done', { sessionId: capturedPorygonId ?? null })
    } catch (err) {
      console.error('[prd-chat/stream] error:', err)
      send('error_msg', { content: String(err) })
    } finally {
      clearInterval(hb)
      reply.raw.end()
    }
  })
}
