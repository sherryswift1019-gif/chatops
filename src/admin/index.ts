import type { FastifyInstance } from 'fastify'
import type { IMAdapter } from '../adapters/im/types.js'
import type { ClaudeRunner } from '../agent/claude-runner.js'
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
import { registerPipelineNodeTypeRoutes } from './routes/pipeline-node-types.js'
import { registerIMTriggersRoutes } from './routes/im-triggers.js'
import { registerAiRoutes } from './routes/ai.js'
import { registerTestServerRoutes } from './routes/test-servers.js'
import { registerTestPipelineRoutes } from './routes/test-pipelines.js'
import { registerTestRunRoutes } from './routes/test-runs.js'
import { registerCapabilityInvocationRoutes } from './routes/capability-invocations.js'
import { registerStageOperationRoutes } from './routes/stage-operations.js'
import { registerPipelineVariableRoutes } from './routes/pipeline-variables.js'
import { registerArtifactRoutes } from './routes/artifacts.js'
// 研发 AI 助手 Admin 路由
import { registerProductKnowledgeRoutes } from './routes/product-knowledge.js'
import { registerBugAnalysisReportRoutes } from './routes/bug-analysis-reports.js'
import { registerMetricsRoutes } from './routes/metrics.js'
import { registerAuditLogRoutes } from './routes/audit-log.js'
import { registerOnboardingRoutes } from './routes/onboarding.js'
import { registerPrdDocumentRoutes } from './routes/prd-documents.js'
import { registerPrdChatRoutes } from './routes/prd-chat.js'
import { registerPrdMetricsRoutes } from './routes/prd-metrics.js'
import { pipelineBindingsRoutes } from './routes/pipeline-bindings.js'
import { registerDryRunRoutes } from './routes/dryrun.js'
import { registerPipelineWebhookRoutes } from './routes/pipeline-webhooks.js'
import { registerPipelineScheduleRoutes } from './routes/pipeline-schedules.js'
import { registerToolsRoutes } from './routes/tools.js'
import { registerE2eTargetRoutes } from './routes/e2e-targets.js'
import { registerE2eSpecRoutes } from './routes/e2e-specs.js'
import { registerE2eEvidenceRoutes } from './routes/e2e-evidence.js'
import { registerE2eRunRoutes } from './routes/e2e-runs.js'
import { registerE2ePlaybookDraftRoutes } from './routes/e2e-playbook-drafts.js'

export async function adminPlugin(
  app: FastifyInstance,
  opts: { adapters?: IMAdapter[]; runner?: ClaudeRunner } = {}
): Promise<void> {
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
  await registerPipelineNodeTypeRoutes(app)
  await registerIMTriggersRoutes(app)
  await registerTestServerRoutes(app)
  await registerTestPipelineRoutes(app)
  await registerTestRunRoutes(app)
  await registerCapabilityInvocationRoutes(app)
  await registerStageOperationRoutes(app)
  await registerPipelineVariableRoutes(app)
  await registerArtifactRoutes(app)
  await registerAiRoutes(app)
  // 研发 AI 助手
  await registerProductKnowledgeRoutes(app)
  await registerBugAnalysisReportRoutes(app)
  await registerMetricsRoutes(app)
  await registerAuditLogRoutes(app)
  await registerOnboardingRoutes(app)
  await registerPrdDocumentRoutes(app)
  await registerPrdMetricsRoutes(app)
  if (opts.runner) {
    await registerPrdChatRoutes(app, { runner: opts.runner })
  }
  await app.register(pipelineBindingsRoutes)
  await registerDryRunRoutes(app)
  await registerPipelineWebhookRoutes(app)
  await registerPipelineScheduleRoutes(app)
  await registerToolsRoutes(app)
  await registerE2eTargetRoutes(app)
  await registerE2eSpecRoutes(app)
  await registerE2eEvidenceRoutes(app)
  await registerE2eRunRoutes(app)
  await registerE2ePlaybookDraftRoutes(app)
}
