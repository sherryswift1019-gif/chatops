import type { FastifyInstance } from 'fastify'
import { registerSystemConfigRoutes } from './routes/system-config.js'
import { registerProductLineRoutes } from './routes/product-lines.js'
import { registerProjectRoutes } from './routes/projects.js'
import { registerEnvironmentRoutes } from './routes/environments.js'
import { registerApprovalRuleRoutes } from './routes/approval-rules.js'
import { registerDingTalkUserRoutes } from './routes/dingtalk-users.js'
import { registerToolPermissionRoutes } from './routes/tool-permissions.js'
import { registerCapabilityRoutes } from './routes/capabilities.js'
import { registerPipelineToolRoutes } from './routes/pipeline-tools.js'
import { registerAiRoutes } from './routes/ai.js'
import { registerTestServerRoutes } from './routes/test-servers.js'
import { registerTestPipelineRoutes } from './routes/test-pipelines.js'
import { registerTestRunRoutes } from './routes/test-runs.js'

export async function adminPlugin(app: FastifyInstance): Promise<void> {
  await registerSystemConfigRoutes(app)
  await registerProductLineRoutes(app)
  await registerProjectRoutes(app)
  await registerEnvironmentRoutes(app)
  await registerApprovalRuleRoutes(app)
  await registerDingTalkUserRoutes(app)
  await registerToolPermissionRoutes(app)
  await registerCapabilityRoutes(app)
  await registerPipelineToolRoutes(app)
  await registerTestServerRoutes(app)
  await registerTestPipelineRoutes(app)
  await registerTestRunRoutes(app)
  await registerAiRoutes(app)
}
