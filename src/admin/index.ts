import type { FastifyInstance } from 'fastify'
import { registerSystemConfigRoutes } from './routes/system-config.js'
import { registerProductLineRoutes } from './routes/product-lines.js'
import { registerProjectRoutes } from './routes/projects.js'
import { registerEnvironmentRoutes } from './routes/environments.js'
import { registerApprovalRuleRoutes } from './routes/approval-rules.js'
import { registerDingTalkUserRoutes } from './routes/dingtalk-users.js'
import { registerToolPermissionRoutes } from './routes/tool-permissions.js'
import { registerCapabilityRoutes } from './routes/capabilities.js'

export async function adminPlugin(app: FastifyInstance): Promise<void> {
  await registerSystemConfigRoutes(app)
  await registerProductLineRoutes(app)
  await registerProjectRoutes(app)
  await registerEnvironmentRoutes(app)
  await registerApprovalRuleRoutes(app)
  await registerDingTalkUserRoutes(app)
  await registerToolPermissionRoutes(app)
  await registerCapabilityRoutes(app)
}
