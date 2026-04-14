import type { FastifyInstance } from 'fastify'
import { listStageOperations } from '../../db/repositories/stage-operations.js'

export async function registerStageOperationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/stage-operations', async (_req, reply) => {
    return reply.send(await listStageOperations())
  })
}
