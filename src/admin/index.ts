import type { FastifyInstance } from 'fastify'
import { registerSystemConfigRoutes } from './routes/system-config.js'
import { registerProductLineRoutes } from './routes/product-lines.js'

export async function adminPlugin(app: FastifyInstance): Promise<void> {
  await registerSystemConfigRoutes(app)
  await registerProductLineRoutes(app)
}
