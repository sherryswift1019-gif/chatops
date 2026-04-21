import type { FastifyInstance } from 'fastify'
import type { IMAdapter } from '../adapters/im/types.js'
import { sessionPlugin, requireAuth } from './auth/session-plugin.js'
import { registerAuthRoutes } from './routes/auth.js'
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
import { registerStageOperationRoutes } from './routes/stage-operations.js'
import { registerPipelineVariableRoutes } from './routes/pipeline-variables.js'
import { registerArtifactRoutes } from './routes/artifacts.js'
// 研发 AI 助手 Admin 路由
import { registerModuleOwnerRoutes } from './routes/module-owners.js'
import { registerProductKnowledgeRoutes } from './routes/product-knowledge.js'
import { registerBugAnalysisReportRoutes } from './routes/bug-analysis-reports.js'
import { registerMetricsRoutes } from './routes/metrics.js'
import { registerAuditLogRoutes } from './routes/audit-log.js'
import { registerOnboardingRoutes } from './routes/onboarding.js'

export async function adminPlugin(app: FastifyInstance, opts: { adapters?: IMAdapter[] } = {}): Promise<void> {
  // Session middleware — must be registered before any route definition
  await app.register(sessionPlugin)

  // E2E 测试控制端点（仅在 E2E_MODE=1 时装载，且必须注册在 requireAuth 之前以跳过 auth）
  if (process.env.E2E_MODE === '1') {
    const { e2eRoutes } = await import('./routes/_e2e.js')
    await app.register(e2eRoutes)
  }

  // preHandler runs on every /admin/* request. Whitelist handled inside requireAuth.
  app.addHook('preHandler', requireAuth)

  // Auth routes (whitelisted, so preHandler lets them through)
  await registerAuthRoutes(app)

  // All other routes — require valid session
  await registerSystemConfigRoutes(app, { adapters: opts.adapters ?? [] })
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
  await registerStageOperationRoutes(app)
  await registerPipelineVariableRoutes(app)
  await registerArtifactRoutes(app)
  await registerAiRoutes(app)
  // 研发 AI 助手
  await registerModuleOwnerRoutes(app)
  await registerProductKnowledgeRoutes(app)
  await registerBugAnalysisReportRoutes(app)
  await registerMetricsRoutes(app)
  await registerAuditLogRoutes(app)
  await registerOnboardingRoutes(app)
}
