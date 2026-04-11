import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { existsSync } from 'fs'
import { config } from './config.js'
import { DingTalkAdapter } from './adapters/im/dingtalk.js'
import { FeishuAdapter } from './adapters/im/feishu.js'
import { GitLabWebhookReceiver } from './adapters/gitlab/webhook-receiver.js'
import { SessionManager } from './agent/session-manager.js'
import { ApprovalGate } from './approval/gate.js'
import { ClaudeRunner } from './agent/claude-runner.js'
import { setApprovalGateHandler } from './agent/tools/approval.js'
import { adminPlugin } from './admin/index.js'
import type { IMAdapter } from './adapters/im/types.js'
import type { TaskQueue } from './agent/task-queue.js'
import type { NormalizedMessage } from './adapters/im/types.js'

// Register all tools by importing them
import './agent/tools/query-deployments.js'
import './agent/tools/list-images.js'
import './agent/tools/get-gitlab-commits.js'
import './agent/tools/get-logs.js'
import './agent/tools/deploy.js'
import './agent/tools/approval.js'
import './agent/tools/role.js'

async function main(): Promise<void> {
  const app = Fastify({ logger: true })

  // Build IM adapters (only create if credentials are configured)
  const adapters: IMAdapter[] = []

  if (config.DINGTALK_CLIENT_ID && config.DINGTALK_CLIENT_SECRET) {
    const dingtalk = new DingTalkAdapter({
      clientId: config.DINGTALK_CLIENT_ID,
      clientSecret: config.DINGTALK_CLIENT_SECRET,
    })
    adapters.push(dingtalk)
    app.log.info('DingTalk adapter enabled (Stream mode)')
  }

  if (config.FEISHU_APP_ID && config.FEISHU_APP_SECRET) {
    const feishu = new FeishuAdapter({
      appId: config.FEISHU_APP_ID,
      appSecret: config.FEISHU_APP_SECRET,
      verificationToken: config.FEISHU_VERIFICATION_TOKEN,
    })
    adapters.push(feishu)
    app.log.info('Feishu adapter enabled (Webhook mode)')
  }

  // Approval gate
  const gate = new ApprovalGate(adapters)
  await gate.initialize()

  // Wire ApprovalTool to gate
  setApprovalGateHandler(async (taskId, action, env, description) => {
    await gate.request(
      { taskId, action, env, description, initiatorName: 'user', groupId: '' },
      async (tid, decision, approverId) => {
        if (decision === 'approved') {
          // Trigger execution session via queue
        }
      }
    )
  })

  // Claude runner
  const runner = new ClaudeRunner()

  // Session manager — processes each message
  const sessionManager = new SessionManager(
    adapters,
    async (msg: NormalizedMessage, queue: TaskQueue) => {
      const adapter = adapters.find(a => a.platform === msg.platform) ?? adapters[0]

      await queue.submit(
        { initiatorId: msg.userId, intent: msg.text },
        async (task) => {
          const context = await sessionManager.buildTaskContext(msg, task.id)
          await runner.run({
            prompt: msg.text,
            context,
            groupId: msg.groupId,
            platform: msg.platform,
            adapter,
          })
        }
      )
    }
  )
  sessionManager.start()

  // Card action (approval responses)
  for (const adapter of adapters) {
    adapter.onCardAction(async (taskId, action, approverId) => {
      if (action === 'approved' || action === 'rejected') {
        await gate.respond(taskId, approverId, action)
      }
    })
  }

  // Admin API routes (under /admin prefix)
  await app.register(adminPlugin, { prefix: '/admin' })

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

  const gitlabReceiver = new GitLabWebhookReceiver(config.GITLAB_WEBHOOK_SECRET)
  gitlabReceiver.onPipelineEvent(async (project, status, pipelineId) => {
    if (status === 'failed') {
      app.log.info({ project, pipelineId }, 'Pipeline failed')
    }
  })

  app.post('/webhook/gitlab', async (req, reply) => {
    await gitlabReceiver.handle(req.body, req.headers as Record<string, string>)
    return reply.send({ ok: true })
  })

  app.get('/health', async () => ({ status: 'ok' }))

  // Serve frontend SPA static files (production build)
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const webDistPath = join(__dirname, '..', 'web', 'dist')
  if (existsSync(webDistPath)) {
    await app.register(fastifyStatic, {
      root: webDistPath,
      prefix: '/',
      wildcard: false,
    })

    // SPA fallback: non-API GET requests return index.html
    app.setNotFoundHandler(async (req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/admin') && !req.url.startsWith('/webhook') && !req.url.startsWith('/health')) {
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

  await app.listen({ port: config.PORT, host: '0.0.0.0' })

  // Graceful shutdown
  const shutdown = async () => {
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
