import type { FastifyInstance } from 'fastify'
import { listDingTalkUsers, getDingTalkUserCount } from '../../db/repositories/dingtalk-users.js'
import { syncDingTalkUsers } from '../services/dingtalk-sync.js'

export async function registerDingTalkUserRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { keyword?: string } }>('/dingtalk/users', async (req, reply) => {
    const users = await listDingTalkUsers(req.query.keyword)
    const count = await getDingTalkUserCount()
    return reply.send({ users, total: count })
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
