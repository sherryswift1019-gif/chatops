import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { existsSync } from 'fs'
import { config } from './config.js'
import { getConfig } from './db/repositories/system-config.js'
import { DingTalkAdapter } from './adapters/im/dingtalk.js'
import { FeishuAdapter } from './adapters/im/feishu.js'
import { GitLabWebhookReceiver } from './adapters/gitlab/webhook-receiver.js'
import { SessionManager } from './agent/session-manager.js'
import { ApprovalGate } from './approval/gate.js'
import { ClaudeRunner } from './agent/claude-runner.js'
import { setApprovalGateHandler } from './agent/tools/approval.js'
import { adminPlugin } from './admin/index.js'
import { getMembershipsByUserId } from './db/repositories/product-line-members.js'
import type { IMAdapter } from './adapters/im/types.js'
import type { TaskQueue } from './agent/task-queue.js'
import type { NormalizedMessage } from './adapters/im/types.js'
import { PipelineApprovalManager } from './pipeline/approval-manager.js'
import { initGraphRunnerDispatchers, resumeFromQiApproval } from './pipeline/graph-runner.js'
import { initQiApprovalManager, isQiApproval, handleQiCardCallback } from './pipeline/qi-approval-manager.js'
import { registerImSender, registerImDmSender } from './pipeline/im-notifier.js'
import { assertRegistryConsistent } from './pipeline/node-types/registry.js'
import { listEnabledNodeTypeKeys } from './db/repositories/pipeline-node-types.js'
import './pipeline/node-types/index.js'  // 触发 5 种 node type 自注册
import { registerWebhookRoute } from './pipeline/webhook-router.js'
import { verifySandboxSafety } from './e2e/sandbox-sentinel.js'

// Register all tools by importing them
import './agent/tools/check-env-status.js'
import './agent/tools/list-images.js'
import './agent/tools/list-gitlab-branches.js'
import './agent/tools/get-gitlab-commits.js'
import './agent/tools/get-logs.js'
import './agent/tools/deploy.js'
import './agent/tools/approval.js'
import './agent/tools/role.js'
import './agent/tools/autotest.js'
import './agent/tools/list-projects.js'
import './agent/tools/list-artifacts.js'
import './agent/tools/get-pipeline-artifact-inputs.js'

// 研发 AI 助手工具
import './agent/tools/read-code.js'
import './agent/tools/download-image.js'
import './agent/tools/switch-version.js'
import './agent/tools/create-issue.js'
import './agent/tools/search-knowledge.js'
import './agent/tools/fix-code.js'
import './agent/tools/run-command.js'
import './agent/tools/run-remote-command.js'
import './agent/tools/run-tests.js'
import './agent/tools/create-mr.js'
import './agent/tools/update-ai-summary.js'
import './agent/tools/review-mr-diff.js'
import './agent/tools/save-prd.js'
import './agent/tools/read-prd.js'
import './agent/tools/update-prd-context.js'
import './agent/tools/search-existing-prds.js'
import './agent/tools/submit-review.js'
import './agent/tools/save-arch.js'
import './agent/tools/read-arch.js'
import './agent/tools/update-arch-context.js'
import './agent/tools/search-existing-arch.js'

// 研发 AI 助手 Agent handler 注册
import { registerAnalysisBugHandler } from './agent/analysis/analyzer.js'
import { registerFixHandlers } from './agent/fix/fix-runner.js'
import { registerReviewHandler } from './agent/review/reviewer.js'
import { registerBuiltinApprovalResolvers } from './agent/approval/resolvers.js'
import { registerCreateMrHandler } from './agent/mr/mr-handler.js'
import { registerNotifyHandler } from './agent/notify/notify-handler.js'
import { registerRequestHandoverHandler } from './agent/handover/request-handover-handler.js'
import './agent/repair/diagnose-repair-handler.js'
import {
  registerPrdSubmitHandler,
  registerPrdCreateMrHandler,
  registerPrdAiReviewHandler,
  registerPrdNotifyHandler,
} from './agent/prd-submit/index.js'
import { setPrdClaudeRunner } from './agent/prd/prd-agent.js'
import { sweepOrphanReviewingPrds } from './db/repositories/prd-documents.js'
import { recoverInflightE2eRuns } from './e2e/pipeline-b/startup-recovery.js'
import { startCleanupScheduler } from './agent/worktree/cleanup-scheduler.js'
import { startPipelineScheduler } from './pipeline/scheduler.js'
import { startMrReconciler, stopMrReconciler } from './agent/reconcile/mr-state-reconciler.js'
import { setApprovalGate, setNotifyDmFn } from './agent/coordinator.js'
import { bootstrapQuickImpl } from './quick-impl/bootstrap.js'
import { startQuickImplWorker, stopQuickImplWorker } from './quick-impl/worker.js'

async function resolveProductLineId(userId: string): Promise<{ productLineId: number; role: string } | null> {
  try {
    const memberships = await getMembershipsByUserId(userId)
    if (memberships.length === 0) return null
    // Use the first product line membership (user's primary product line)
    return { productLineId: memberships[0].productLineId, role: memberships[0].role }
  } catch { return null }
}

async function main(): Promise<void> {
  // 生产环境兜底：禁止 E2E_MODE / CLAUDE_MOCK 误开
  // 这些开关会：
  //   1. 替换 DingTalk 适配器为 MockIMAdapter（真机器人不连）
  //   2. /admin/_e2e/* 控制端点完全绕过 auth（可匿名触发 Pipeline、清审批状态）
  //   3. Claude 调用短路为 mock 响应（真 AI 不跑）
  // 任何一条误开都会让后端失去生产保护，必须 hard-fail 阻止启动
  if (process.env.NODE_ENV === 'production') {
    if (process.env.E2E_MODE === '1') {
      throw new Error('E2E_MODE=1 is not allowed when NODE_ENV=production (bypasses auth + replaces IM adapter)')
    }
    if (process.env.CLAUDE_MOCK === '1') {
      throw new Error('CLAUDE_MOCK=1 is not allowed when NODE_ENV=production (returns canned responses instead of real Claude)')
    }
  }

  const app = Fastify({ logger: true })

  // Build IM adapters (only create if credentials are configured in system_config)
  const adapters: IMAdapter[] = []

  if (process.env.E2E_MODE === '1') {
    // E2E 模式：用 MockIMAdapter 替代真实钉钉/飞书连接，保持生产行为不变
    const { MockIMAdapter } = await import('./adapters/im/mock.js')
    adapters.push(new MockIMAdapter())
    app.log.info('E2E_MODE enabled: MockIMAdapter loaded in place of DingTalk/Feishu')
  } else {
    const dingtalkCfg = (await getConfig('dingtalk'))?.value as { clientId?: string; clientSecret?: string } | undefined
    if (dingtalkCfg?.clientId && dingtalkCfg?.clientSecret) {
      const dingtalk = new DingTalkAdapter({
        clientId: dingtalkCfg.clientId,
        clientSecret: dingtalkCfg.clientSecret,
      })
      adapters.push(dingtalk)
      app.log.info('DingTalk adapter enabled (Stream mode)')
    }

    const feishuCfg = (await getConfig('feishu'))?.value as { appId?: string; appSecret?: string; verificationToken?: string } | undefined
    if (feishuCfg?.appId && feishuCfg?.appSecret) {
      const feishu = new FeishuAdapter({
        appId: feishuCfg.appId,
        appSecret: feishuCfg.appSecret,
        verificationToken: feishuCfg.verificationToken ?? '',
      })
      adapters.push(feishu)
      app.log.info('Feishu adapter enabled (Webhook mode)')
    }
  }

  // Approval gate
  const gate = new ApprovalGate(adapters)
  await gate.initialize()
  setApprovalGate(gate)

  // 节点类型注册一致性检查 —— DB enabled 行 ↔ 代码 register 必须一致
  // 必须在 adapter.start() 之前，避免在打开 DingTalk WebSocket / Feishu webhook
  // 监听之后才发现注册漂移导致脏启动。
  const dbEnabledKeys = await listEnabledNodeTypeKeys()
  assertRegistryConsistent(dbEnabledKeys)
  console.log(`[server] node-type registry verified: ${dbEnabledKeys.size} types`)

  // 注入钉钉 DM 通知回调（Review 完成后通知模块负责人）
  const primaryAdapter = adapters[0]
  if (primaryAdapter) {
    setNotifyDmFn(async (userId: string, message: string) => {
      await primaryAdapter.sendDirectMessage(userId, { text: message })
    })
  }

  // Register IM senders so pipeline im-notifier can push prompts/progress.
  for (const adapter of adapters) {
    registerImSender(adapter.platform, async (groupId, text) => {
      await adapter.sendMessage({ type: 'group', id: groupId }, { text })
    })
    // dm 节点 executor (T10) 走 DM 单独 registry。
    registerImDmSender(adapter.platform, async (userId, text) => {
      await adapter.sendDirectMessage(userId, { text })
      return {}
    })
  }

  // Claude runner
  const runner = new ClaudeRunner()

  // Pending approval contexts — keyed by taskId
  const pendingApprovals = new Map<string, { groupId: string; platform: string; initiatorId: string; initiatorRole?: string; productLineId?: number; originalPrompt: string; lockProject?: string; lockEnv?: string }>()

  // Wire ApprovalTool to gate
  setApprovalGateHandler(async (taskId, action, env, description, meta) => {
    // 保存执行上下文以便审批通过后恢复
    pendingApprovals.set(taskId, meta)

    await gate.request(
      { taskId, imTriggerKey: action, env, description, initiatorName: meta.initiatorId, groupId: meta.groupId },
      async (tid, decision, approverId) => {
        const pending = pendingApprovals.get(tid)
        pendingApprovals.delete(tid)
        if (!pending) return

        const adapter = adapters.find(a => a.platform === pending.platform) ?? adapters[0]
        if (decision === 'approved') {
          console.log(`[Server] Approval granted for task ${tid}, triggering execution`)
          await adapter.sendMessage(
            { type: 'group', id: pending.groupId },
            { text: `✅ 审批通过（审批人: ${approverId}），正在执行...` }
          )
          // 以 executionMode 重新执行（此时 request_approval 被过滤，只暴露执行工具）
          await runner.run({
            prompt: pending.originalPrompt,
            context: {
              taskId: tid,
              groupId: pending.groupId,
              platform: pending.platform,
              initiatorId: pending.initiatorId,
              initiatorRole: (pending.initiatorRole as any) ?? null,
              productLineId: pending.productLineId,
            },
            groupId: pending.groupId,
            platform: pending.platform,
            adapter,
            executionMode: true,
            productLineId: pending.productLineId,
            lockProject: pending.lockProject,
            lockEnv: pending.lockEnv,
          })
        } else {
          await adapter.sendMessage(
            { type: 'group', id: pending.groupId },
            { text: `❌ 审批被拒绝（审批人: ${approverId}），操作已取消。` }
          )
        }
      }
    )
  })

  // analyzer/fix/review 均已改用 runClaudeCli，不再需要注入 ClaudeRunner
  // PRD agent 仍走 Porygon-based ClaudeRunner
  setPrdClaudeRunner(runner)

  // 注册 Agent capability handler
  registerAnalysisBugHandler()
  registerFixHandlers()
  registerReviewHandler()
  registerCreateMrHandler()
  registerNotifyHandler()
  registerRequestHandoverHandler()

  // PRD 主动提交 MR pipeline handlers（prd_submit 走 handler-path，内部自己 runPipeline）
  registerPrdSubmitHandler()
  registerPrdCreateMrHandler()
  registerPrdAiReviewHandler()
  registerPrdNotifyHandler()

  // 注册 pipeline approval resolver（审批人动态查询策略）
  // L3 "方案审批" stage 通过 approverIdsResolver='primary_project_owner' 路由到这里
  registerBuiltinApprovalResolvers()

  // 启动 worktree 清理调度器
  startCleanupScheduler()

  // 启动 pipeline cron 调度器
  await startPipelineScheduler()

  // 启动 MR 状态对账调度器（webhook 漏发兜底，默认 5min）
  startMrReconciler()

  // Quick-Impl：创建/更新流水线模板，启动排队工作器 + Worktree 清理
  try {
    await bootstrapQuickImpl()
  } catch (err) {
    app.log.warn({ err }, '[quick-impl] bootstrap failed (non-fatal)')
  }
  startQuickImplWorker()

  // 启动兜底：把被上次进程中断的 PRD（status=reviewing 停留 >5min）推到 review_blocked，
  // 避免 UI 永久卡在 "Agent 正在处理" 的 spinner。
  try {
    const swept = await sweepOrphanReviewingPrds(5 * 60 * 1000)
    if (swept > 0) {
      app.log.info(`[prd-sweep] marked ${swept} orphan reviewing PRD(s) as review_blocked`)
    }
  } catch (err) {
    app.log.warn({ err }, '[prd-sweep] sweep orphan reviewing PRDs failed')
  }

  // 启动兜底：把被上次进程中断的 e2e run（running / awaiting_fix）全部标 aborted
  // + best-effort 清理沙盒 / 删 iteration branch，防资源泄漏。
  try {
    await recoverInflightE2eRuns()
  } catch (err) {
    app.log.warn({ err }, '[E2eRecovery] startup recovery failed (non-fatal)')
  }

  // Session manager — processes each message
  const sessionManager = new SessionManager(
    adapters,
    async (msg: NormalizedMessage, queue: TaskQueue) => {
      const adapter = adapters.find(a => a.platform === msg.platform) ?? adapters[0]

      await queue.submit(
        { initiatorId: msg.userId, intent: msg.text },
        async (task) => {
          const context = await sessionManager.buildTaskContext(msg, task.id)
          const membership = await resolveProductLineId(msg.userId)
          if (membership) {
            context.initiatorRole = membership.role as any
            context.productLineId = membership.productLineId
          }
          await runner.run({
            prompt: msg.text,
            context,
            groupId: msg.groupId,
            platform: msg.platform,
            adapter,
            productLineId: membership?.productLineId,
            userName: msg.userName,
            senderDingtalkId: (msg.rawPayload as any)?.senderId,
          })
        }
      )
    },
    (userId: string) => runner.endUserSession(userId)
  )
  sessionManager.start()

  // Initialize pipeline approval manager
  PipelineApprovalManager.initialize(adapters)

  // Wire Task 3 adapter resume handlers → graph-runner.resumeRun. Must run
  // after PipelineApprovalManager.initialize() so getInstance() succeeds.
  initGraphRunnerDispatchers()

  // Initialize QI approval manager (DingTalk card → claimWaiter → resumeFromQiApproval)
  initQiApprovalManager(adapters, async (_waiterId, waiter) => {
    await resumeFromQiApproval(waiter.id, waiter)
  })

  // Card action (approval responses)
  for (const adapter of adapters) {
    adapter.onCardAction(async (taskId, action, approverId) => {
      console.log(`[Card] 审批回调路由: taskId=${taskId} action=${action} approver=${approverId}`)

      // 1. QI 审批（qi-approval-manager 发出的卡片）
      if (isQiApproval(taskId)) {
        await handleQiCardCallback(taskId, action, approverId).catch((err) => {
          app.log.error({ err, taskId }, 'qi handleCardCallback failed')
        })
        return
      }

      // 2. 旧 Pipeline approval 节点（agree/reject → approved/rejected）
      const decision: 'approved' | 'rejected' | null =
        action === 'agree' || action === 'approved' ? 'approved' :
        action === 'reject' || action === 'rejected' ? 'rejected' :
        null
      if (!decision) {
        console.warn('[Card] unknown action from card callback:', action)
        return
      }

      const mgr = PipelineApprovalManager.getInstance()
      if (mgr.isPipelineApproval(taskId)) {
        await mgr.handleCallback(taskId, decision, approverId).catch((err) => {
          app.log.error({ err, taskId }, 'pipeline handleCallback failed')
        })
        return
      }

      // 3. 通用审批门（工具审批等）
      await gate.respond(taskId, approverId, decision)
    })
  }

  // Admin API routes (under /admin prefix)
  await app.register(adminPlugin, { prefix: '/admin', adapters, runner })

  // HTTP Routes (DingTalk uses Stream mode — no webhook route needed)
  const feishuAdapter = adapters.find(a => a.platform === 'feishu')
  if (feishuAdapter) {
    app.post('/webhook/feishu', async (req, reply) => {
      const body = req.body as Record<string, unknown>
      if (body.type === 'url_verification') {
        return reply.send({ challenge: body.challenge })
      }
      await feishuAdapter.handleWebhook(body, req.headers as Record<string, string>)
      return reply.send({ ok: true })
    })
  }

  const gitlabWebhookSecret = ((await getConfig('gitlab'))?.value as { webhookSecret?: string } | undefined)?.webhookSecret ?? ''
  const gitlabReceiver = new GitLabWebhookReceiver(gitlabWebhookSecret)
  gitlabReceiver.onPipelineEvent(async (project, status, pipelineId) => {
    if (status === 'failed') {
      app.log.info({ project, pipelineId }, 'Pipeline failed')
    }
  })

  app.post('/webhook/gitlab', async (req, reply) => {
    await gitlabReceiver.handle(req.body, req.headers as Record<string, string>)
    return reply.send({ ok: true })
  })

  await registerWebhookRoute(app)

  app.get('/health', async () => ({ status: 'ok' }))

  // 测试端点：通过 triggerCapability 触发完整分析流程（含 Issue 创建）
  app.post('/api/test/analyze', async (req, reply) => {
    const body = req.body as { message: string; version?: string; productLineId?: number }
    if (!body.message) return reply.status(400).send({ error: 'message required' })

    const { triggerCapability } = await import('./agent/coordinator.js')
    const result = await triggerCapability({
      capabilityKey: 'analyze_bug',
      context: {
        taskId: `test-${Date.now()}`,
        groupId: 'test',
        platform: 'test',
        initiatorId: '183832601538060368',
        initiatorRole: 'admin',
      },
      extraParams: {
        message: body.message,
        productLineId: body.productLineId ?? 1,
        version: body.version,
      },
    })

    return reply.send(result)
  })

  // Serve frontend SPA static files (production build)
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const webDistPath = join(__dirname, '..', 'web', 'dist')
  if (existsSync(webDistPath)) {
    await app.register(fastifyStatic, {
      root: webDistPath,
      prefix: '/',
      wildcard: true,
    })

    // SPA fallback: non-API GET requests return index.html
    app.setNotFoundHandler(async (req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/admin') && !req.url.startsWith('/api') && !req.url.startsWith('/webhook') && !req.url.startsWith('/health')) {
        return reply.sendFile('index.html')
      }
      return reply.status(404).send({ error: 'not found' })
    })
    app.log.info('Frontend SPA enabled from web/dist/')
  } else {
    // No SPA build — show API info at root
    app.get('/', async () => ({
      name: 'ChatOps Platform',
      version: '1.0.0',
      status: 'running',
      endpoints: { health: '/health', admin: '/admin/*' },
    }))
  }

  // Start adapters with long connections (e.g. DingTalk Stream)
  for (const adapter of adapters) {
    await adapter.start?.()
  }

  await verifySandboxSafety()
  await app.listen({ port: config.PORT, host: '0.0.0.0' })

  // Graceful shutdown
  const shutdown = async () => {
    stopMrReconciler()
    stopQuickImplWorker()
    for (const adapter of adapters) {
      await adapter.stop?.()
    }
    await app.close()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
