import type { FastifyInstance } from 'fastify'
import { listDingTalkUsersPaged } from '../../db/repositories/dingtalk-users.js'
import { syncDingTalkUsers } from '../services/dingtalk-sync.js'

export async function registerDingTalkUserRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { keyword?: string; page?: string; page_size?: string } }>('/dingtalk/users', async (req, reply) => {
    const { keyword, page, page_size } = req.query
    const result = await listDingTalkUsersPaged({
      keyword,
      page: page ? Number(page) : undefined,
      pageSize: page_size ? Number(page_size) : undefined,
    })
    return reply.send({ items: result.items, total: result.total })
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
