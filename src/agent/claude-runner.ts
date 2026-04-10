import Anthropic from '@anthropic-ai/sdk'
import type { IMAdapter } from '../adapters/im/types.js'
import { getAllTools, getTool } from './tools/index.js'
import type { TaskContext } from './tools/types.js'
import { getRecentTasks } from '../db/repositories/tasks.js'

export interface RunOptions {
  prompt: string
  context: TaskContext
  groupId: string
  platform: string
  adapter: IMAdapter
  executionMode?: boolean  // true = post-approval execution session (skip approval tool)
  approvedBy?: string
}

export class ClaudeRunner {
  private client: Anthropic

  constructor() {
    this.client = new Anthropic()
  }

  private static buildSystemPrompt(ctx: TaskContext, executionMode: boolean): string {
    if (executionMode) {
      return `You are a DevOps automation agent executing a pre-approved operation.
The operation has already been reviewed and approved by an authorized user.
Proceed with the execution immediately without asking for further confirmation.
Use execute_deploy, execute_rollback, or execute_restart as needed.
Report progress clearly.`
    }
    return `You are a DevOps assistant for this engineering team. Users interact with you via group chat.

Your capabilities:
- query_deployments: check deployment history and current status
- list_images: show available images from Harbor registry
- get_logs: retrieve and analyze container logs
- get_gitlab_commits: fetch recent code commits from GitLab
- request_approval: REQUIRED before any deployment/rollback to staging or production
- execute_restart: restart a service (approval required for staging/prod)
- manage_role: grant/revoke user roles (admin only)

IMPORTANT RULES:
1. Before deploying to staging or production, always call request_approval first
2. After calling request_approval, tell the user approval has been requested and end your response
3. The current user's role is: ${ctx.initiatorRole ?? 'unknown (treat as developer)'}
4. Always confirm the specific image tag with the user before requesting approval for deployment

When analyzing logs, look for ERROR/WARN patterns and correlate with recent commits if relevant.`
  }

  async run(opts: RunOptions): Promise<void> {
    const { prompt, context, adapter, executionMode = false, approvedBy } = opts
    const tools = getAllTools()
      .filter(t => !executionMode || t.name !== 'request_approval')

    const toolDefs = tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    }))
    const systemPrompt = ClaudeRunner.buildSystemPrompt(context, executionMode)

    // Load recent context from DB
    const recentTasks = await getRecentTasks(context.groupId, 5)
    const contextNote = recentTasks.length
      ? `\nRecent group activity:\n${recentTasks.map(t => `- ${t.intent} (${t.status})`).join('\n')}`
      : ''

    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: prompt + contextNote }
    ]

    try {
      // Agentic tool-use loop
      while (true) {
        const response = await this.client.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 4096,
          system: systemPrompt,
          tools: toolDefs,
          messages,
        })

        // Process response content
        let textOutput = ''
        const toolUseBlocks: Anthropic.ToolUseBlock[] = []

        for (const block of response.content) {
          if (block.type === 'text') {
            textOutput += block.text
          } else if (block.type === 'tool_use') {
            toolUseBlocks.push(block)
          }
        }

        // Send text output to IM
        if (textOutput.trim()) {
          await adapter.sendMessage(
            { type: 'group', id: opts.groupId },
            { text: textOutput }
          )
        }

        // If no tool use, we're done
        if (response.stop_reason === 'end_turn' || toolUseBlocks.length === 0) {
          break
        }

        // Execute tools and collect results
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
                { text: `⚠️ Tool error: ${result.output}` }
              )
            }
          } else {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: `Unknown tool: ${toolUse.name}`,
              is_error: true,
            })
          }
        }

        messages.push({ role: 'user', content: toolResults })
      }
    } catch (err) {
      await adapter.sendMessage(
        { type: 'group', id: opts.groupId },
        { text: `❌ Agent error: ${String(err)}` }
      )
    }
  }
}
