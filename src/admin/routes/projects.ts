import type { FastifyInstance } from 'fastify'
import { listProjects, createProject, updateProject, deleteProject } from '../../db/repositories/projects-repo.js'

export async function registerProjectRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { product_line_id?: string } }>('/projects', async (req, reply) => {
    const plId = req.query.product_line_id ? Number(req.query.product_line_id) : undefined
    return reply.send(await listProjects(plId))
  })

  app.post<{ Body: { productLineId: number; name: string; displayName: string; gitlabPath?: string; harborProject?: string; ownerId?: string; ownerName?: string; description?: string } }>(
    '/projects', async (req, reply) => {
      const { productLineId, name, displayName } = req.body
      if (!productLineId || !name || !displayName) return reply.status(400).send({ error: 'productLineId, name, displayName required' })
      const item = await createProject(req.body)
      return reply.status(201).send(item)
    }
  )

  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/projects/:id', async (req, reply) => {
      const item = await updateProject(Number(req.params.id), req.body as any)
      if (!item) return reply.status(404).send({ error: 'not found' })
      return reply.send(item)
    }
  )

  app.delete<{ Params: { id: string } }>('/projects/:id', async (req, reply) => {
    const deleted = await deleteProject(Number(req.params.id))
    if (!deleted) return reply.status(404).send({ error: 'not found' })
    return reply.status(204).send()
  })
}
