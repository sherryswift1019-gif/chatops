import type { FastifyInstance } from 'fastify'
import { registerSystemConfigRoutes } from './routes/system-config.js'

export async function adminPlugin(app: FastifyInstance): Promise<void> {
  await registerSystemConfigRoutes(app)
}
