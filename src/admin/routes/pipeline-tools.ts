import type { FastifyInstance } from 'fastify'
import { listPipelineTools } from '../../db/repositories/pipeline-tools.js'

export async function registerPipelineToolRoutes(app: FastifyInstance): Promise<void> {
  app.get('/pipeline-tools', async (_req, reply) => {
    return reply.send(await listPipelineTools())
  })
}
