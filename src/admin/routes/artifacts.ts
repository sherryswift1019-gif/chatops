import type { FastifyInstance } from 'fastify'
import { listArtifacts } from '../../pipeline/artifact-resolver.js'

export async function registerArtifactRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: {
    listUrl: string
    glob?: string
    authHeaders?: Record<string, string>
  } }>('/artifacts/list', async (req, reply) => {
    const { listUrl, glob, authHeaders } = req.body
    if (!listUrl) return reply.status(400).send({ error: 'listUrl required' })
    try {
      const files = await listArtifacts({ listUrl, glob: glob ?? '', authHeaders })
      return reply.send({ files })
    } catch (e) {
      return reply.status(502).send({ error: (e as Error).message })
    }
  })
}
