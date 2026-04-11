import type { FastifyInstance } from 'fastify'
import { getToolPermissions, batchSetToolPermissions } from '../../db/repositories/tool-permissions.js'
import { getAllTools } from '../../agent/tools/index.js'
import { DEFAULT_TOOL_ROLES } from '../../agent/tools/types.js'

// Import all tool modules to ensure they're registered
import '../../agent/tools/query-deployments.js'
import '../../agent/tools/list-images.js'
import '../../agent/tools/get-gitlab-commits.js'
import '../../agent/tools/get-logs.js'
import '../../agent/tools/deploy.js'
import '../../agent/tools/approval.js'
import '../../agent/tools/role.js'

export async function registerToolPermissionRoutes(app: FastifyInstance): Promise<void> {
  // List all tools with their default allowed roles
  app.get('/tools', async (_req, reply) => {
    const tools = getAllTools().map(t => ({
      name: t.name,
      description: t.description,
      riskLevel: t.riskLevel,
      defaultAllowedRoles: DEFAULT_TOOL_ROLES[t.name] ?? ['developer', 'tester', 'ops', 'admin'],
    }))
    return reply.send(tools)
  })

  // Get permission overrides for a product line
  app.get<{ Querystring: { product_line_id?: string } }>(
    '/tool-permissions',
    async (req, reply) => {
      const plId = req.query.product_line_id ? Number(req.query.product_line_id) : undefined
      if (plId === undefined) {
        return reply.status(400).send({ error: 'product_line_id required' })
      }
      return reply.send(await getToolPermissions(plId))
    }
  )

  // Batch set permission overrides for a product line
  app.put<{ Body: { productLineId: number; permissions: Array<{ toolName: string; envName: string; allowedRoles: string[] }> } }>(
    '/tool-permissions',
    async (req, reply) => {
      const { productLineId, permissions } = req.body
      if (!productLineId || !Array.isArray(permissions)) {
        return reply.status(400).send({ error: 'productLineId and permissions array required' })
      }
      const result = await batchSetToolPermissions(productLineId, permissions)
      return reply.send(result)
    }
  )
}
