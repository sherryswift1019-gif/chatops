import Anthropic from '@anthropic-ai/sdk'
import type { IMAdapter } from '../adapters/im/types.js'
import { getTool, getAllTools } from './tools/index.js'
import type { AgentTool, TaskContext } from './tools/types.js'
import { getRecentTasks } from '../db/repositories/tasks.js'
import { listCapabilities, getCapabilityByKey } from '../db/repositories/capabilities.js'
import { checkCapabilityAccess } from '../db/repositories/product-line-capabilities.js'

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
  private client: Anthropic

  constructor() {
    this.client = new Anthropic()
  }

  async run(opts: RunOptions): Promise<void> {
    const { prompt, context, adapter, executionMode = false, productLineId } = opts

    try {
      // In execution mode (post-approval), skip intent detection
      if (executionMode) {
        await this.executeWithTools(opts, getAllTools().filter(t => t.name !== 'request_approval'))
        return
      }

      // Step 1: Detect intent
      const intent = await this.detectIntent(prompt, context)
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

      // Step 3: Check capability access (if product line is known)
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

      // Step 5: Execute with scoped tools
      await this.executeWithTools(opts, capabilityTools)

    } catch (err) {
      await adapter.sendMessage(
        { type: 'group', id: opts.groupId },
        { text: `❌ Agent error: ${String(err)}` }
      )
    }
  }

  private async detectIntent(prompt: string, context: TaskContext): Promise<DetectedIntent | null> {
    const capabilities = await listCapabilities()
    const capList = capabilities.map(c => `- ${c.key}: ${c.displayName} (${c.description})`).join('\n')

    const response = await this.client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 512,
      system: `你是一个意图分类器。用户会用自然语言描述他们想做的事情。
根据以下能力列表，识别用户想使用哪个能力。

可用能力:
${capList}

返回 JSON 格式（不要加 markdown 代码块）：
{"capability":"能力key","project":"项目名(如有)","env":"环境名(如有)","summary":"一句话总结用户意图"}

如果用户的请求不属于任何已知能力，返回：
{"capability":"unknown","summary":"无法识别的请求"}`,
      messages: [{ role: 'user', content: prompt }],
    })

    // context is used for future extensibility (e.g. per-user intent history)
    void context

    const text = response.content.find(b => b.type === 'text')?.text ?? ''
    try {
      const parsed = JSON.parse(text) as DetectedIntent
      if (parsed.capability === 'unknown') return null
      return parsed
    } catch {
      return null
    }
  }

  private async executeWithTools(opts: RunOptions, tools: AgentTool[]): Promise<void> {
    const { prompt, context, adapter, executionMode = false } = opts

    const toolDefs = tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    }))

    const systemPrompt = executionMode
      ? `你是一个 DevOps 自动化 agent，正在执行已审批的操作。直接执行，无需再次确认。`
      : `你是一个 DevOps 助手。用户通过群聊与你交互。

当前用户角色: ${context.initiatorRole ?? 'developer'}

规则:
1. 部署到 staging/production 前，必须先调用 request_approval
2. 调用 request_approval 后，告知用户已发起审批并结束回复
3. 部署前确认镜像标签
4. 分析日志时关注 ERROR/WARN 模式`

    const recentTasks = await getRecentTasks(context.groupId, 5)
    const contextNote = recentTasks.length
      ? `\n最近活动:\n${recentTasks.map(t => `- ${t.intent} (${t.status})`).join('\n')}`
      : ''

    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: prompt + contextNote }
    ]

    // Agentic tool-use loop
    while (true) {
      const response = await this.client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        system: systemPrompt,
        tools: toolDefs,
        messages,
      })

      let textOutput = ''
      const toolUseBlocks: Anthropic.ToolUseBlock[] = []

      for (const block of response.content) {
        if (block.type === 'text') textOutput += block.text
        else if (block.type === 'tool_use') toolUseBlocks.push(block)
      }

      if (textOutput.trim()) {
        await adapter.sendMessage({ type: 'group', id: opts.groupId }, { text: textOutput })
      }

      if (response.stop_reason === 'end_turn' || toolUseBlocks.length === 0) break

      messages.push({ role: 'assistant', content: response.content })

      const toolResults: Anthropic.ToolResultBlockParam[] = []
      for (const toolUse of toolUseBlocks) {
        const tool = getTool(toolUse.name)
        if (tool) {
          const result = await tool.execute(toolUse.input, context)
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: result.output,
            is_error: !result.success,
          })
          if (!result.success) {
            await adapter.sendMessage(
              { type: 'group', id: opts.groupId },
              { text: `⚠️ 工具错误: ${result.output}` }
            )
          }
        } else {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: `未知工具: ${toolUse.name}`,
            is_error: true,
          })
        }
      }

      messages.push({ role: 'user', content: toolResults })
    }
  }
}
