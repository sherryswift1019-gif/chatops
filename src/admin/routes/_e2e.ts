/**
 * E2E 测试控制端点 — 仅在 E2E_MODE=1 时由 adminPlugin 注册。
 *
 * 端点：
 *   POST /admin/_e2e/claude            { key, response } → 给指定 key 追加一个 mock 响应
 *   POST /admin/_e2e/reset             清空所有 mock 响应 + sent messages
 *   GET  /admin/_e2e/messages?kind&to  查询 MockIMAdapter 收到的发送记录
 *   GET  /admin/_e2e/health            返回 { e2eMode, claudeMock }
 *   POST /admin/_e2e/analyze-and-dispatch { productLineId, message, initiatorId? }
 *        — 完整触发 analyze_bug + handleAnalysisComplete（bug 类型会触发 Pipeline）
 *          返回 { reportId, classification, level, pipelineRunId }
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
   * 完整触发 analyze_bug → handleAnalysisComplete 链路。
   * bug 分类会触发 Pipeline（runPipeline 内部 await 直到 pipeline 跑完），
   * 返回时 report 已经到达终态（pipeline_success / aborted）。
   */
  app.post<{
    Body: { productLineId: number; message: string; initiatorId?: string }
  }>('/_e2e/analyze-and-dispatch', async (req, reply) => {
    const { productLineId, message, initiatorId } = req.body ?? ({} as any)
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

    let pipelineRunId: number | undefined
    if (classification === 'bug') {
      await handleAnalysisComplete(reportId, level, classification, initiator)
      // handleAnalysisComplete 内部 await runPipeline 到 onComplete 回调之前都完成
      const { getBugAnalysisReportById } = await import(
        '../../db/repositories/bug-analysis-reports.js'
      )
      const reloaded = await getBugAnalysisReportById(reportId)
      pipelineRunId = reloaded?.pipelineRunId ?? undefined
    }

    return reply.send({
      success: true,
      data: { reportId, classification, level, pipelineRunId },
    })
  })
}
