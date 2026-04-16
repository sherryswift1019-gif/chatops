import type { FastifyInstance } from 'fastify'
import { listDingTalkUsersPaged } from '../../db/repositories/dingtalk-users.js'
import { syncDingTalkUsers } from '../services/dingtalk-sync.js'

export async function registerDingTalkUserRoutes(app: FastifyInstance): Promise<void> {
  app.get('/dingtalk/users', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          keyword: { type: 'string' },
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        },
      },
    },
  }, async (req, reply) => {
    const { keyword, page, limit } = req.query as { keyword?: string; page: number; limit: number }
    const result = await listDingTalkUsersPaged(keyword ?? null, page, limit)
    return reply.send({ data: result.data, total: result.total, page, limit })
  })

  app.post('/dingtalk/users/sync', async (_req, reply) => {
    try {
      const result = await syncDingTalkUsers()
      return reply.send({ success: true, ...result })
    } catch (err) {
      return reply.status(500).send({ success: false, error: String(err) })
    }
  })
}
