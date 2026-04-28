import type { FastifyInstance } from 'fastify'
import {
  listPipelineWebhooks,
  createPipelineWebhook,
  updatePipelineWebhook,
  deletePipelineWebhook,
  rotatePipelineWebhookToken,
} from '../../db/repositories/pipeline-webhooks-repo.js'
import { getTestPipelineById } from '../../db/repositories/test-pipelines.js'

export async function registerPipelineWebhookRoutes(app: FastifyInstance): Promise<void> {
  // GET /pipelines/:pipelineId/webhooks — 列表（token 脱敏）
  app.get<{ Params: { pipelineId: string } }>(
    '/pipelines/:pipelineId/webhooks',
    async (req, reply) => {
      const pipelineId = Number(req.params.pipelineId)
      if (!await getTestPipelineById(pipelineId)) {
        return reply.status(404).send({ error: 'pipeline not found' })
      }
      return reply.send(await listPipelineWebhooks(pipelineId))
    },
  )

  // POST /pipelines/:pipelineId/webhooks — 创建（完整 token 仅此一次）
  app.post<{
    Params: { pipelineId: string }
    Body: { name: string; defaultServers?: Record<string, string[]> }
  }>(
    '/pipelines/:pipelineId/webhooks',
    async (req, reply) => {
      const pipelineId = Number(req.params.pipelineId)
      if (!await getTestPipelineById(pipelineId)) {
        return reply.status(404).send({ error: 'pipeline not found' })
      }
      const { name, defaultServers } = req.body
      if (!name?.trim()) return reply.status(400).send({ error: 'name required' })

      const wh = await createPipelineWebhook({
        pipelineId,
        name: name.trim(),
        createdBy: req.session.get('username') ?? '',
        defaultServers,
      })
      const url = `/webhook/pipeline/${wh.token}`
      return reply.status(201).send({ ...wh, url })
    },
  )

  // POST /pipelines/:pipelineId/webhooks/:id/rotate — 换新 token
  app.post<{ Params: { pipelineId: string; id: string } }>(
    '/pipelines/:pipelineId/webhooks/:id/rotate',
    async (req, reply) => {
      const id = Number(req.params.id)
      try {
        const { newToken } = await rotatePipelineWebhookToken(id)
        return reply.send({ token: newToken, url: `/webhook/pipeline/${newToken}` })
      } catch {
        return reply.status(404).send({ error: 'webhook not found' })
      }
    },
  )

  // PATCH /pipelines/:pipelineId/webhooks/:id — 更新 name/enabled/defaultServers
  app.patch<{
    Params: { pipelineId: string; id: string }
    Body: { name?: string; enabled?: boolean; defaultServers?: Record<string, string[]> | null }
  }>(
    '/pipelines/:pipelineId/webhooks/:id',
    async (req, reply) => {
      const updated = await updatePipelineWebhook(Number(req.params.id), req.body)
      if (!updated) return reply.status(404).send({ error: 'webhook not found' })
      return reply.send(updated)
    },
  )

  // DELETE /pipelines/:pipelineId/webhooks/:id
  app.delete<{ Params: { pipelineId: string; id: string } }>(
    '/pipelines/:pipelineId/webhooks/:id',
    async (req, reply) => {
      const deleted = await deletePipelineWebhook(Number(req.params.id))
      if (!deleted) return reply.status(404).send({ error: 'webhook not found' })
      return reply.status(204).send()
    },
  )
}
