import type { FastifyInstance } from 'fastify'
import { listNodeTypes } from '../../db/repositories/pipeline-node-types.js'

export async function registerPipelineNodeTypeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/pipeline-node-types', async (_req, reply) => {
    const items = await listNodeTypes()
    return reply.send({ items: items.filter(t => t.enabled) })
  })
}
