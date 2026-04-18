/**
 * E2E 测试控制端点 — 仅在 E2E_MODE=1 时由 adminPlugin 注册。
 *
 * 端点：
 *   POST /admin/_e2e/claude            { key, response } → 给指定 key 追加一个 mock 响应
 *   POST /admin/_e2e/reset             清空所有 mock 响应 + sent messages
 *   GET  /admin/_e2e/messages?kind&to  查询 MockIMAdapter 收到的发送记录
 *   GET  /admin/_e2e/health            返回 { e2eMode, claudeMock }
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
}
