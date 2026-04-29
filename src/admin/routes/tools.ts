import type { FastifyInstance } from 'fastify'
import { getAllTools } from '../../agent/tools/index.js'
import { DEFAULT_TOOL_ROLES } from '../../agent/tools/types.js'

export async function registerToolsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin/tools', async () => {
    return getAllTools().map((t) => ({
      name: t.name,
      description: t.description,
      riskLevel: t.riskLevel,
      requiredRole: t.requiredRole ?? null,
      defaultRoles: DEFAULT_TOOL_ROLES[t.name] ?? null,
    }))
  })
}
