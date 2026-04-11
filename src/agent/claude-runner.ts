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

export class ClaudeRunner {
  private porygon: Porygon

  constructor() {
    this.porygon = createPorygon({
      defaultBackend: 'claude',
      backends: {
        claude: {
          model: 'sonnet',
          interactive: false,
        },
      },
      defaults: {
        timeoutMs: 300_000,
        maxTurns: 20,
      },
    })
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
      const intent = await this.detectIntent(prompt)
      if (!intent) {
        await adapter.sendMessage(
          { type: 'group', id: opts.groupId },
          { text: '抱歉，我无法理解您的请求。我目前支持：查看部署状态、查看镜像、查看日志、查看提交记录、部署服务、回滚、重启服务、管理角色。' }
        )
        return
      }

      // Step 2: Get capability definition
      const capability = await getCapabilityByKey(intent.capability)
      if (!capability) {
        await adapter.sendMessage(
          { type: 'group', id: opts.groupId },
          { text: `抱歉，「${intent.capability}」不是我支持的能力。` }
        )
        return
      }

      // Step 3: Check capability access
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

      // Step 4: Get tools for this capability
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

      // Step 5: Execute via Porygon
      await this.executeWithPorygon(opts, capabilityTools)

    } catch (err) {
      await adapter.sendMessage(
        { type: 'group', id: opts.groupId },
        { text: `❌ Agent error: ${String(err)}` }
      )
    }
  }

  private async detectIntent(prompt: string): Promise<DetectedIntent | null> {
    const capabilities = await listCapabilities()
    const capList = capabilities.map(c => `- ${c.key}: ${c.displayName} (${c.description})`).join('\n')

    try {
      const result = await this.porygon.run({
        prompt: `分析以下用户请求，识别意图。

可用能力:
${capList}

用户请求: ${prompt}

返回 JSON（不要代码块）：
{"capability":"能力key","project":"项目名(如有)","env":"环境名(如有)","summary":"一句话总结"}

如果不属于任何已知能力，返回：
{"capability":"unknown","summary":"无法识别"}`,
        maxTurns: 1,
        disallowedTools: ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep'],
      })

      const parsed = JSON.parse(result) as DetectedIntent
      return parsed.capability === 'unknown' ? null : parsed
    } catch {
      return null
    }
  }

  private async executeWithPorygon(opts: RunOptions, tools: AgentTool[]): Promise<void> {
    const { prompt, context, adapter, executionMode = false } = opts

    const systemPrompt = executionMode
      ? '你是一个 DevOps 自动化 agent，正在执行已审批的操作。直接执行，无需再次确认。'
      : `你是一个 DevOps 助手。用户通过群聊与你交互。

当前用户角色: ${context.initiatorRole ?? 'developer'}

规则:
1. 部署到 staging/production 前，必须先调用 request_approval
2. 调用 request_approval 后，告知用户已发起审批并结束回复
3. 部署前确认镜像标签
4. 分析日志时关注 ERROR/WARN 模式
5. 只使用提供给你的 MCP 工具，不要使用 Bash 等内置工具`

    const recentTasks = await getRecentTasks(context.groupId, 5)
    const contextNote = recentTasks.length
      ? `\n最近活动:\n${recentTasks.map(t => `- ${t.intent} (${t.status})`).join('\n')}`
      : ''

    const toolNames = tools.map(t => t.name)

    // Build MCP server config to expose our custom tools
    const mcpServerPath = join(__dirname, 'mcp-server.ts')

    let textBuffer = ''

    for await (const msg of this.porygon.query({
      prompt: prompt + contextNote,
      appendSystemPrompt: systemPrompt,
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
      // Only allow our custom tools from MCP server (block built-in tools)
      disallowedTools: ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
    })) {
      switch (msg.type) {
        case 'assistant':
          if (msg.text && !msg.turnComplete) {
            textBuffer += msg.text
          }
          break

        case 'tool_use':
          // Tool execution happens inside CLI via MCP server
          // We can log it for observability
          if (msg.output && !toolNames.includes(msg.toolName ?? '')) {
            // Unknown tool output — skip
          }
          break

        case 'result':
          // Final result — flush any remaining text
          if (msg.text) {
            textBuffer += msg.text
          }
          break

        case 'error':
          await adapter.sendMessage(
            { type: 'group', id: opts.groupId },
            { text: `⚠️ Agent 错误: ${msg.message}` }
          )
          return
      }
    }

    // Send accumulated text to IM
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
