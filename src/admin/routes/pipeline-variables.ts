import type { FastifyInstance } from 'fastify'
import { VARIABLE_CATALOG } from '../../pipeline/variables.js'

export async function registerPipelineVariableRoutes(app: FastifyInstance): Promise<void> {
  app.get('/pipeline-variables', async (_req, reply) => {
    return reply.send(VARIABLE_CATALOG)
  })
}
