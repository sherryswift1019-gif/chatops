import type { FastifyInstance } from 'fastify'
import {
  listDingTalkUsersPaged,
  getDingTalkUserById,
  deleteUser,
} from '../../db/repositories/dingtalk-users.js'
import { syncDingTalkUsers } from '../services/dingtalk-sync.js'
import { checkUserActiveReferences } from '../services/user-reference-check.js'

export async function registerDingTalkUserRoutes(app: FastifyInstance): Promise<void> {
  // 列表（支持 status 过滤）
  app.get('/dingtalk/users', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          keyword: { type: 'string' },
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          status: { type: 'string', enum: ['all', 'active', 'resigned'], default: 'all' },
        },
      },
    },
  }, async (req, reply) => {
    const { keyword, page, limit, status } = req.query as {
      keyword?: string; page: number; limit: number; status: 'all' | 'active' | 'resigned'
    }
    const result = await listDingTalkUsersPaged(keyword ?? null, page, limit, status)
    return reply.send({ data: result.data, total: result.total, page, limit })
  })

  // 同步
  app.post('/dingtalk/users/sync', async (_req, reply) => {
    try {
      const result = await syncDingTalkUsers()
      return reply.send({ success: true, ...result })
    } catch (err) {
      return reply.status(500).send({ success: false, error: String(err) })
    }
  })

  // 查引用（A 类）
  app.get('/dingtalk/users/:userId/references', {
    schema: {
      params: { type: 'object', properties: { userId: { type: 'string' } }, required: ['userId'] },
    },
  }, async (req, reply) => {
    const { userId } = req.params as { userId: string }
    const result = await checkUserActiveReferences(userId)
    return reply.send(result)
  })

  // 删除（后端二次校验引用）
  app.delete('/dingtalk/users/:userId', {
    schema: {
      params: { type: 'object', properties: { userId: { type: 'string' } }, required: ['userId'] },
    },
  }, async (req, reply) => {
    const { userId } = req.params as { userId: string }

    const user = await getDingTalkUserById(userId)
    if (!user) return reply.status(404).send({ error: '用户不存在' })
    if (!user.resignedAt) return reply.status(409).send({ error: '只允许删除已离职用户' })

    const refs = await checkUserActiveReferences(userId)
    if (refs.blocked) {
      return reply.status(409).send({
        error: '用户仍被引用，无法删除',
        references: refs.references,
      })
    }

    await deleteUser(userId)
    return reply.send({ success: true })
  })
}
