import type { FastifyInstance } from 'fastify'
import { listEnvironments, createEnvironment, updateEnvironment, deleteEnvironment } from '../../db/repositories/environments-repo.js'

export async function registerEnvironmentRoutes(app: FastifyInstance): Promise<void> {
  app.get('/environments', async (_req, reply) => {
    return reply.send(await listEnvironments())
  })

  app.post<{ Body: { name: string; displayName: string; sortOrder?: number } }>(
    '/environments', async (req, reply) => {
      const { name, displayName, sortOrder } = req.body
      if (!name || !displayName) return reply.status(400).send({ error: 'name and displayName required' })
      const item = await createEnvironment({ name, displayName, sortOrder })
      return reply.status(201).send(item)
    }
  )

  app.put<{ Params: { id: string }; Body: { name?: string; displayName?: string; sortOrder?: number } }>(
    '/environments/:id', async (req, reply) => {
      const item = await updateEnvironment(Number(req.params.id), req.body)
      if (!item) return reply.status(404).send({ error: 'not found' })
      return reply.send(item)
    }
  )

  app.delete<{ Params: { id: string } }>('/environments/:id', async (req, reply) => {
    const deleted = await deleteEnvironment(Number(req.params.id))
    if (!deleted) return reply.status(404).send({ error: 'not found' })
    return reply.status(204).send()
  })
}
