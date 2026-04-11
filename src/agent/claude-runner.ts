import { createPorygon, type Porygon } from '@snack-kit/porygon'
import type { IMAdapter } from '../adapters/im/types.js'
import { getTool, getAllTools } from './tools/index.js'
import type { AgentTool, TaskContext } from './tools/types.js'
import { getRecentTasks } from '../db/repositories/tasks.js'
import { listCapabilities, getCapabilityByKey } from '../db/repositories/capabilities.js'
import { checkCapabilityAccess } from '../db/repositories/product-line-capabilities.js'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export interface RunOptions {
  prompt: string
  context: TaskContext
  groupId: string
  platform: string
  adapter: IMAdapter
  executionMode?: boolean
  approvedBy?: string
  productLineId?: number
}

interface DetectedIntent {
  capability: string
  project?: string
  env?: string
  summary: string
}

// Session per group with auto-expiry
interface GroupSession {
  sessionId: string
  lastUsed: number
}

const SESSION_TTL_MS = 8 * 60 * 60 * 1000 // 8 hours

export class ClaudeRunner {
  private porygon: Porygon
  private sessions = new Map<string, GroupSession>()

  constructor() {
    this.porygon = createPorygon({
      defaultBackend: 'claude',
      backends: {
        claude: {
          model: 'sonnet',
          interactive: false,
          cliPath: join(__dirname, '..', '..', 'node_modules', '.bin', 'claude'),
        },
      },
      defaults: {
        timeoutMs: 300_000,
        maxTurns: 20,
      },
    })
  }

  private getSessionId(groupId: string): string | undefined {
    const session = this.sessions.get(groupId)
    if (!session) return undefined
    if (Date.now() - session.lastUsed > SESSION_TTL_MS) {
      this.sessions.delete(groupId)
      return undefined
    }
    return session.sessionId
  }

  private saveSessionId(groupId: string, sessionId: string): void {
    this.sessions.set(groupId, { sessionId, lastUsed: Date.now() })
  }

  async run(opts: RunOptions): Promise<void> {
    const { prompt, context, adapter, executionMode = false, productLineId } = opts

    try {
      if (executionMode) {
        const tools = getAllTools().filter(t => t.name !== 'request_approval')
        await this.executeWithPorygon(opts, tools)
        return
      }

      // Step 1: Detect intent
      console.log('[Runner] Step 1: detecting intent for:', prompt)
      const intent = await this.detectIntent(prompt)
      console.log('[Runner] Intent result:', JSON.stringify(intent))

      // Greeting or unknown
      if (!intent || intent.capability === 'greet') {
        const caps = await listCapabilities()
        const capsList = caps.map(c => `• ${c.displayName} — ${c.description}`).join('\n')
        await adapter.sendMessage(
          { type: 'group', id: opts.groupId },
          { text: `你好！我是 ChatOps 助手 🤖\n\n我目前支持以下能力：\n${capsList}\n\n你可以直接用自然语言告诉我你想做什么，比如「查看日志」「部署到开发环境」等。` }
        )
        return
      }

      // Step 2: Get capability
      const capability = await getCapabilityByKey(intent.capability)
      if (!capability) {
        await adapter.sendMessage(
          { type: 'group', id: opts.groupId },
          { text: `抱歉，「${intent.capability}」不是我支持的能力。` }
        )
        return
      }

      // Step 3: Check access
      if (productLineId) {
        const envName = intent.env ?? '*'
        const userRole = context.initiatorRole ?? 'developer'
        const access = await checkCapabilityAccess(productLineId, capability.key, envName, userRole)
        if (!access.allowed) {
          await adapter.sendMessage(
            { type: 'group', id: opts.groupId },
            { text: `⛔ 无法执行「${capability.displayName}」：${access.reason}` }
          )
          return
        }
      }

      // Step 4: Get tools
      const capabilityTools = capability.toolNames
        .map(name => getTool(name))
        .filter((t): t is AgentTool => t !== undefined)

      if (capabilityTools.length === 0) {
        await adapter.sendMessage(
          { type: 'group', id: opts.groupId },
          { text: `「${capability.displayName}」能力暂无可用工具。` }
        )
        return
      }

      // Step 5: Execute with session context
      await this.executeWithPorygon(opts, capabilityTools)

    } catch (err) {
      console.error('[Runner] Error:', err)
      await adapter.sendMessage(
        { type: 'group', id: opts.groupId },
        { text: `❌ Agent error: ${String(err)}` }
      ).catch(e => console.error('[Runner] Failed to send error to IM:', e))
    }
  }

  private async detectIntent(prompt: string): Promise<DetectedIntent | null> {
    const capabilities = await listCapabilities()
    const capList = capabilities.map(c => `- ${c.key}: ${c.displayName} (${c.description})`).join('\n')

    try {
      console.log('[Runner] Calling porygon.run for intent detection...')
      const result = await this.porygon.run({
        prompt: `分析以下用户请求，识别意图。

可用能力:
${capList}

用户请求: ${prompt}

返回 JSON（不要代码块）：
{"capability":"能力key","project":"项目名(如有)","env":"环境名(如有)","summary":"一句话总结"}

如果用户在打招呼、问好、自我介绍请求，返回：
{"capability":"greet","summary":"打招呼"}

如果不属于任何已知能力，返回：
{"capability":"unknown","summary":"无法识别"}`,
        maxTurns: 1,
        disallowedTools: ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep'],
        envVars: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '' },
      })

      console.log('[Runner] Porygon raw result:', result)
      const cleaned = result.replace(/```json?\n?/g, '').replace(/```\n?/g, '').trim()
      const parsed = JSON.parse(cleaned) as DetectedIntent
      return parsed.capability === 'unknown' ? null : parsed
    } catch (err) {
      console.error('[Runner] detectIntent error:', err)
      return null
    }
  }

  private async executeWithPorygon(opts: RunOptions, tools: AgentTool[]): Promise<void> {
    const { prompt, context, adapter, executionMode = false, groupId } = opts

    const systemPrompt = executionMode
      ? '你是一个 DevOps 自动化 agent，正在执行已审批的操作。直接执行，无需再次确认。'
      : `你是一个 DevOps 助手。用户通过群聊与你交互。你可以记住之前的对话内容。

当前用户角色: ${context.initiatorRole ?? 'developer'}

规则:
1. 部署到 staging/production 前，必须先调用 request_approval
2. 调用 request_approval 后，告知用户已发起审批并结束回复
3. 部署前确认镜像标签
4. 分析日志时关注 ERROR/WARN 模式
5. 只使用提供给你的 MCP 工具，不要使用 Bash 等内置工具
6. 如果用户的请求引用了之前的对话内容，利用上下文理解用户意图`

    const recentTasks = await getRecentTasks(context.groupId, 5)
    const contextNote = recentTasks.length
      ? `\n最近活动:\n${recentTasks.map(t => `- ${t.intent} (${t.status})`).join('\n')}`
      : ''

    const toolNames = tools.map(t => t.name)
    const mcpServerPath = join(__dirname, 'mcp-server.ts')
    console.log(`[Runner] executeWithPorygon: mcpServerPath=${mcpServerPath}, tools=[${toolNames.join(',')}]`)

    // Resume existing session for this group if available
    const existingSessionId = this.getSessionId(groupId)
    if (existingSessionId) {
      console.log(`[Runner] Resuming session: ${existingSessionId} for group: ${groupId}`)
    } else {
      console.log(`[Runner] New session for group: ${groupId}`)
    }

    let textBuffer = ''

    try {
      console.log('[Runner] Starting porygon.query()...')
      for await (const msg of this.porygon.query({
        prompt: prompt + contextNote,
        appendSystemPrompt: systemPrompt,
        ...(existingSessionId ? { resume: existingSessionId } : {}),
        mcpServers: {
          'chatops-tools': {
            command: 'node',
            args: ['--import', 'tsx/esm', mcpServerPath],
            env: {
              CHATOPS_TASK_CONTEXT: JSON.stringify(context),
              DATABASE_URL: process.env.DATABASE_URL ?? '',
              ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '',
            },
          },
        },
        disallowedTools: ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
        envVars: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '' },
      })) {
        console.log(`[Runner] Porygon msg: type=${msg.type}`, msg.type === 'error' ? msg.message : '')

        // Capture sessionId from any message
        if ('sessionId' in msg && msg.sessionId) {
          this.saveSessionId(groupId, msg.sessionId as string)
        }

        switch (msg.type) {
          case 'assistant':
            if (msg.text) textBuffer += msg.text
            break

          case 'tool_use':
            console.log(`[Runner] Tool called: ${msg.toolName}`)
            break

          case 'result':
            if (msg.text) textBuffer += msg.text
            // Capture sessionId from result
            if ('sessionId' in msg && msg.sessionId) {
              this.saveSessionId(groupId, msg.sessionId as string)
            }
            console.log(`[Runner] Porygon result received`)
            break

          case 'error':
            console.error(`[Runner] Porygon error: ${msg.message}`)
            await adapter.sendMessage(
              { type: 'group', id: opts.groupId },
              { text: `⚠️ Agent 错误: ${msg.message}` }
            )
            return
        }
      }
      console.log(`[Runner] Porygon query completed, textBuffer length=${textBuffer.length}`)
    } catch (err) {
      console.error('[Runner] executeWithPorygon error:', err)
      // Session might be invalid, clear it
      this.sessions.delete(groupId)
      await adapter.sendMessage(
        { type: 'group', id: opts.groupId },
        { text: `❌ 执行错误: ${String(err)}` }
      ).catch(e => console.error('[Runner] Failed to send error:', e))
      return
    }

    if (textBuffer.trim()) {
      await adapter.sendMessage(
        { type: 'group', id: opts.groupId },
        { text: textBuffer.trim() }
      )
    }
  }

  async dispose(): Promise<void> {
    await this.porygon.dispose()
  }
}
