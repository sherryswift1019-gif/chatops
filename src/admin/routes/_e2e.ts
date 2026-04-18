/**
 * E2E 测试控制端点 — 仅在 E2E_MODE=1 时由 adminPlugin 注册。
 *
 * 端点：
 *   POST /admin/_e2e/claude            { key, response } → 给指定 key 追加一个 mock 响应
 *   POST /admin/_e2e/reset             清空所有 mock 响应 + sent messages
 *   GET  /admin/_e2e/messages?kind&to  查询 MockIMAdapter 收到的发送记录
 *   GET  /admin/_e2e/health            返回 { e2eMode, claudeMock }
 *   POST /admin/_e2e/approve           { issueIid, decision } →
 *                                      封装 PipelineApprovalManager.tryHandleCommand
 *   POST /admin/_e2e/im/incoming       { text, groupId, userId, userName } →
 *                                      模拟群内消息进入（简化路径：只复现 Step 0
 *                                      的 @ 去除 + tryHandleCommand，不跑完整的
 *                                      ClaudeRunner intent 检测链路）
 *   POST /admin/_e2e/analyze-and-dispatch { productLineId, message, initiatorId?, async? }
 *        — 完整触发 analyze_bug + handleAnalysisComplete（bug 类型会触发 Pipeline）
 *          返回 { reportId, classification, level, pipelineRunId }
 *          async=true 时 handleAnalysisComplete 不 await，用于 L3 审批 block 场景
 *
 * 无需 auth（E2E_MODE 本身就是开关，生产模式不会装载此路由）。
 */
import type { FastifyInstance } from 'fastify'
import {
  setMockResponse,
  resetMockResponses,
  getSentMessages,
  clearSentMessages,
  isE2EMode,
  isClaudeMock,
  type RecordedMessage,
} from '../../agent/mocks/e2e-store.js'

// 该插件被 adminPlugin（prefix=/admin）装载，因此路径写相对形式 /_e2e/*，
// 实际外部 URL 为 /admin/_e2e/*。
export async function e2eRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { key: string; response: unknown } }>(
    '/_e2e/claude',
    async (req, reply) => {
      const { key, response } = req.body ?? ({} as { key?: string; response?: unknown })
      if (!key || typeof key !== 'string') {
        return reply.status(400).send({ error: 'key required' })
      }
      setMockResponse(key, response)
      return reply.send({ ok: true })
    },
  )

  app.post('/_e2e/reset', async (_req, reply) => {
    resetMockResponses()
    clearSentMessages()
    return reply.send({ ok: true })
  })

  app.get<{ Querystring: { kind?: string; to?: string } }>(
    '/_e2e/messages',
    async (req, reply) => {
      const { kind, to } = req.query ?? {}
      const filter: { kind?: RecordedMessage['kind']; to?: string } = {}
      if (kind === 'group' || kind === 'direct' || kind === 'card') filter.kind = kind
      if (to) filter.to = to
      return reply.send(getSentMessages(filter))
    },
  )

  app.get('/_e2e/health', async (_req, reply) => {
    return reply.send({ e2eMode: isE2EMode(), claudeMock: isClaudeMock() })
  })

  /**
   * 触发 PipelineApprovalManager.tryHandleCommand（群内审批命令封装）。
   * 用于 L3 审批 e2e 场景：dispatch 异步 block 在审批时，通过此端点模拟
   * 用户在群里发 `approve #<issueIid>` / `reject #<issueIid>` / `reanalyze #<issueIid>`。
   *
   * 入参：
   *   { issueIid: string|number, decision: 'approve'|'reject'|'reanalyze' }
   * 返回：
   *   { ok: true, handled: boolean }
   */
  app.post<{
    Body: { issueIid: string | number; decision: 'approve' | 'reject' | 'reanalyze' }
  }>('/_e2e/approve', async (req, reply) => {
    const { issueIid, decision } = req.body ?? ({} as any)
    if (issueIid === undefined || !decision) {
      return reply.status(400).send({ error: 'issueIid and decision required' })
    }
    const { PipelineApprovalManager } = await import('../../pipeline/approval-manager.js')
    const mgr = PipelineApprovalManager.getInstance()
    const handled = mgr.tryHandleCommand(`${decision} #${issueIid}`)
    return reply.send({ ok: true, handled })
  })

  /**
   * 模拟 IM 入站消息 → 复现 ClaudeRunner.run() Step 0 的审批命令拦截。
   *
   * 简化说明：
   *   真实链路是 钉钉 Stream → adapter onMessage → SessionManager → TaskQueue →
   *     ClaudeRunner.run() → Step 0 拦截审批命令 → tryHandleCommand。
   *   e2e 下 intent 检测依赖真实 Claude CLI，不可用（会 spawn claude 子进程
   *   污染后续测试状态），因此此端点只复现 Step 0 的 `cleanedForApproval` 去 @
   *   逻辑 + tryHandleCommand 调用，跳过 Porygon intent 检测环节（在 spec 里
   *   用 `[简化-跳过 ClaudeRunner 全路径]` 标注）。
   *
   *   价值：相比 /admin/_e2e/approve 直接给 issueIid，这里测试「真实消息文本」
   *   的解析路径（@机器人 mention 去除 + approve/reject/reanalyze 正则匹配）。
   *
   * 入参：
   *   { text: string, groupId: string, userId: string, userName?: string }
   * 返回：
   *   { ok: true, handled: boolean, cleanedText: string }
   *   - handled: tryHandleCommand 是否匹配到 pending 审批
   */
  app.post<{
    Body: {
      text: string
      groupId: string
      userId: string
      userName?: string
    }
  }>('/_e2e/im/incoming', async (req, reply) => {
    const { text, groupId, userId } = req.body ?? ({} as any)
    if (!text || !groupId || !userId) {
      return reply.status(400).send({ error: 'text, groupId, userId required' })
    }

    // 复现 ClaudeRunner.run() Step 0 的 cleanedForApproval + tryHandleCommand
    const cleanedText = text.replace(/@[\u4e00-\u9fff]+/g, '').trim()
    let handled = false
    try {
      const { PipelineApprovalManager } = await import('../../pipeline/approval-manager.js')
      const mgr = PipelineApprovalManager.getInstance()
      handled = mgr.tryHandleCommand(cleanedText)
    } catch (err) {
      console.log('[e2e/im/incoming] tryHandleCommand err:', err instanceof Error ? err.message : err)
    }

    return reply.send({ ok: true, handled, cleanedText })
  })

  /**
   * 完整触发 analyze_bug → handleAnalysisComplete 链路。
   *
   * 默认同步模式：bug 分类会触发 Pipeline（runPipeline 内部 await 直到 pipeline 跑完），
   *   返回时 report 已经到达终态（pipeline_success / aborted）。
   *
   * 异步模式（async=true）：analyze 完成后立即返回 reportId，handleAnalysisComplete
   *   在后台继续执行（不 await）。测试侧可 poll 事件或 report.status 判断进度。
   *   用于 L3 审批场景：pipeline 会 block 在 approve_l3 stage 等待审批命令。
   */
  app.post<{
    Body: {
      productLineId: number
      message: string
      initiatorId?: string
      async?: boolean
    }
  }>('/_e2e/analyze-and-dispatch', async (req, reply) => {
    const { productLineId, message, initiatorId, async: asyncMode } = req.body ?? ({} as any)
    if (!productLineId || !message) {
      return reply.status(400).send({ error: 'productLineId and message required' })
    }
    const { handleAnalyzeBug } = await import('../../agent/analysis/analyzer.js')
    const { handleAnalysisComplete } = await import('../../agent/coordinator.js')

    const initiator = initiatorId ?? 'u-trigger'
    const analyzerResult = await handleAnalyzeBug({
      capabilityKey: 'analyze_bug',
      context: {
        taskId: `e2e-${Date.now()}`,
        groupId: 'e2e',
        platform: 'e2e',
        initiatorId: initiator,
        initiatorRole: 'developer',
      },
      extraParams: { productLineId, message },
    })

    if (!analyzerResult.success) {
      return reply.send({
        success: false,
        error: analyzerResult.error,
        output: analyzerResult.output,
      })
    }

    const data = (analyzerResult.data ?? {}) as Record<string, unknown>
    const reportId = data.reportId as number
    const level = data.level as string
    const classification = data.classification as string

    if (classification !== 'bug') {
      return reply.send({
        success: true,
        data: { reportId, classification, level, pipelineRunId: undefined },
      })
    }

    if (asyncMode) {
      // 不 await：让 handleAnalysisComplete 在后台跑，pipeline 可在审批处 block
      void handleAnalysisComplete(reportId, level, classification, initiator).catch(err => {
        console.error('[e2e] async handleAnalysisComplete error:', err)
      })
      return reply.send({
        success: true,
        data: { reportId, classification, level, pipelineRunId: undefined, async: true },
      })
    }

    await handleAnalysisComplete(reportId, level, classification, initiator)
    const { getBugAnalysisReportById } = await import(
      '../../db/repositories/bug-analysis-reports.js'
    )
    const reloaded = await getBugAnalysisReportById(reportId)
    const pipelineRunId = reloaded?.pipelineRunId ?? undefined

    return reply.send({
      success: true,
      data: { reportId, classification, level, pipelineRunId },
    })
  })
}
