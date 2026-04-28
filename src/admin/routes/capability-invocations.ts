import type { FastifyInstance } from 'fastify'
import {
  listInvocations,
  getInvocationById,
} from '../../db/repositories/capability-invocations.js'
import {
  getDingTalkUserById,
  getDingTalkUsersByIds,
} from '../../db/repositories/dingtalk-users.js'

export async function registerCapabilityInvocationRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get(
    '/capability-invocations',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            capability_key: { type: 'string' },
            platform: { type: 'string' },
            status: { type: 'string', enum: ['running', 'success', 'failed'] },
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
        },
      },
    },
    async (req, reply) => {
      const q = req.query as {
        capability_key?: string
        platform?: string
        status?: string
        page: number
        limit: number
      }
      const result = await listInvocations({
        capabilityKey: q.capability_key ?? null,
        platform: q.platform ?? null,
        status: q.status ?? null,
        page: q.page,
        limit: q.limit,
      })
      const userIds = [
        ...new Set(result.data.map((r) => r.triggeredBy).filter(Boolean)),
      ]
      const userMap = await getDingTalkUsersByIds(userIds)
      return reply.send({
        data: result.data.map((r) => {
          const u = userMap.get(r.triggeredBy)
          return {
            ...r,
            triggeredByName: u?.name,
            triggeredByAvatar: u?.avatar,
          }
        }),
        total: result.total,
        page: q.page,
        limit: q.limit,
      })
    },
  )

  app.get<{ Params: { id: string } }>(
    '/capability-invocations/:id',
    async (req, reply) => {
      const id = Number(req.params.id)
      if (!Number.isFinite(id) || id <= 0) {
        return reply.status(400).send({ error: 'invalid id' })
      }
      const inv = await getInvocationById(id)
      if (!inv) return reply.status(404).send({ error: 'not found' })
      const u = await getDingTalkUserById(inv.triggeredBy).catch(() => null)
      return reply.send({
        ...inv,
        triggeredByName: u?.name,
        triggeredByAvatar: u?.avatar,
      })
    },
  )
}
