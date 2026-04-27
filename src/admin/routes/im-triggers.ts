import type { FastifyInstance } from 'fastify'
import {
  listIMTriggers,
  getIMTrigger,
  createIMTrigger,
  updateIMTrigger,
  deleteIMTrigger,
  getIMTriggerById,
  type CreateIMTriggerInput,
} from '../../db/repositories/im-triggers.js'

export async function registerIMTriggersRoutes(app: FastifyInstance): Promise<void> {
  app.get('/im-triggers', async () => {
    return await listIMTriggers()
  })

  app.get<{ Params: { key: string } }>('/im-triggers/:key', async (req, reply) => {
    const trigger = await getIMTrigger(req.params.key)
    if (!trigger) return reply.status(404).send({ error: 'not_found' })
    return trigger
  })

  app.post<{ Body: CreateIMTriggerInput }>('/im-triggers', async (req, reply) => {
    const { pipelineId, capabilityKey } = req.body
    if (pipelineId != null && capabilityKey != null) {
      return reply.status(400).send({ error: 'pipeline_id 和 capability_key 不能同时设置' })
    }
    const created = await createIMTrigger(req.body)
    return reply.status(201).send(created)
  })

  app.put<{ Params: { id: string }, Body: Partial<CreateIMTriggerInput> }>('/im-triggers/:id', async (req, reply) => {
    const { pipelineId, capabilityKey } = req.body
    if (pipelineId != null && capabilityKey != null) {
      return reply.status(400).send({ error: 'pipeline_id 和 capability_key 不能同时设置' })
    }
    const updated = await updateIMTrigger(Number(req.params.id), req.body)
    if (!updated) return reply.status(404).send({ error: 'not_found' })
    return updated
  })

  app.delete<{ Params: { id: string } }>('/im-triggers/:id', async (req, reply) => {
    const existing = await getIMTriggerById(Number(req.params.id))
    if (!existing) return reply.status(404).send({ error: 'not_found' })
    await deleteIMTrigger(Number(req.params.id))
    return reply.status(204).send()
  })
}
