import type { FastifyInstance } from 'fastify'
import {
  listE2eTargetProjects,
  getE2eTargetProject,
  updateE2eTargetProject,
} from '../../db/repositories/e2e-target-projects.js'
import { resolveGitlabConfig } from '../../config/gitlab.js'

export async function registerE2eTargetRoutes(app: FastifyInstance): Promise<void> {
  app.get('/e2e-targets', async (_req, reply) => {
    return reply.send(await listE2eTargetProjects())
  })

  app.get<{ Params: { id: string } }>('/e2e-targets/:id', async (req, reply) => {
    const project = await getE2eTargetProject(req.params.id)
    if (!project) return reply.status(404).send({ error: 'not found' })
    return reply.send(project)
  })

  app.get('/e2e-targets-gitlab-base-url', async (_req, reply) => {
    const cfg = await resolveGitlabConfig()
    return reply.send({ url: cfg.url ?? null })
  })

  app.put<{
    Params: { id: string }
    Body: {
      displayName?: string
      gitlabRepo?: string
      defaultBranch?: string
      workingDir?: string
      scripts?: { build: string; deploy: string; test: string; fix?: string }
      defaultSandboxKind?: string
    }
  }>('/e2e-targets/:id', async (req, reply) => {
    const project = await getE2eTargetProject(req.params.id)
    if (!project) return reply.status(404).send({ error: 'not found' })
    const updated = await updateE2eTargetProject(req.params.id, req.body)
    return reply.send(updated)
  })
}
