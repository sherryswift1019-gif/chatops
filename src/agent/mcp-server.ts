/**
 * ChatOps MCP Server — exposes custom agent tools to Claude CLI via stdio.
 * Launched as a subprocess by Porygon/Claude CLI.
 *
 * Usage: node --import tsx/esm src/agent/mcp-server.ts
 * Env: CHATOPS_TASK_CONTEXT (JSON), DATABASE_URL
 */
import { appendFileSync } from 'fs'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'

function mcpLog(msg: string) {
  const line = `[${new Date().toISOString()}] [MCP] ${msg}\n`
  try { appendFileSync('/tmp/mcp-server.log', line) } catch { /* ignore */ }
}
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { getAllTools, getTool } from './tools/index.js'
import type { TaskContext } from './tools/types.js'

// Register all tools
import './tools/query-deployments.js'
import './tools/list-images.js'
import './tools/get-gitlab-commits.js'
import './tools/get-logs.js'
import './tools/deploy.js'
import './tools/approval.js'
import './tools/role.js'
import './tools/autotest.js'
import './tools/list-projects.js'
import './tools/list-artifacts.js'
import './tools/get-pipeline-artifact-inputs.js'

const server = new Server(
  { name: 'chatops-tools', version: '1.0.0' },
  { capabilities: { tools: {} } }
)

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const ctx: TaskContext = JSON.parse(process.env.CHATOPS_TASK_CONTEXT ?? '{}')
  const { filterToolsByRole } = await import('./mcp-server-utils.js')
  let tools = await filterToolsByRole(getAllTools(), ctx.initiatorRole ?? null, ctx.productLineId)

  // 按 capability 白名单过滤（由 runner 通过环境变量传入）
  const allowedList = process.env.CHATOPS_ALLOWED_TOOLS
  if (allowedList) {
    const allowed = new Set(allowedList.split(','))
    tools = tools.filter(t => allowed.has(t.name))
  }

  return {
    tools: tools.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }
})

// Execute a tool
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = getTool(request.params.name)
  if (!tool) {
    return {
      content: [{ type: 'text' as const, text: `未知工具: ${request.params.name}` }],
      isError: true,
    }
  }

  const context: TaskContext = JSON.parse(process.env.CHATOPS_TASK_CONTEXT ?? '{}')

  // Re-check permission to prevent bypass via direct tool-name call
  const { filterToolsByRole } = await import('./mcp-server-utils.js')
  const permitted = await filterToolsByRole([tool], context.initiatorRole ?? null, context.productLineId)
  if (permitted.length === 0) {
    mcpLog(`Denied tool call: ${request.params.name} role=${context.initiatorRole}`)
    return {
      content: [{ type: 'text' as const, text: `⛔ 无权限调用工具: ${request.params.name}` }],
      isError: true,
    }
  }

  try {
    mcpLog(`Calling tool: ${request.params.name} args=${JSON.stringify(request.params.arguments)}`)
    const result = await tool.execute(request.params.arguments ?? {}, context)
    mcpLog(`Tool result: success=${result.success} output=${result.output.slice(0, 500)}`)
    return {
      content: [{ type: 'text' as const, text: result.output }],
      isError: !result.success,
    }
  } catch (err) {
    return {
      content: [{ type: 'text' as const, text: `工具执行错误: ${String(err)}` }],
      isError: true,
    }
  }
})

// Start stdio transport
const transport = new StdioServerTransport()
await server.connect(transport)
