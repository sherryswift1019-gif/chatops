import type { FastifyInstance } from 'fastify'
import { listE2eTargetProjects, getE2eTargetProject } from '../../db/repositories/e2e-target-projects.js'

export async function registerE2eTargetRoutes(app: FastifyInstance): Promise<void> {
  app.get('/e2e-targets', async (_req, reply) => {
    return reply.send(await listE2eTargetProjects())
  })

  app.get<{ Params: { id: string } }>('/e2e-targets/:id', async (req, reply) => {
    const project = await getE2eTargetProject(req.params.id)
    if (!project) return reply.status(404).send({ error: 'not found' })
    return reply.send(project)
  })
}
