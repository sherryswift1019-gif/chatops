/**
 * ChatOps MCP Server — exposes custom agent tools to Claude CLI via stdio.
 * Launched as a subprocess by Porygon/Claude CLI.
 *
 * Usage: node --import tsx/esm src/agent/mcp-server.ts
 * Env: CHATOPS_TASK_CONTEXT (JSON), DATABASE_URL
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
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

const server = new Server(
  { name: 'chatops-tools', version: '1.0.0' },
  { capabilities: { tools: {} } }
)

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = getAllTools()
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

  // TaskContext passed from claude-runner via env var
  const context: TaskContext = JSON.parse(process.env.CHATOPS_TASK_CONTEXT ?? '{}')

  try {
    const result = await tool.execute(request.params.arguments ?? {}, context)
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
