import type { AgentTool } from './types.js'

const registry = new Map<string, AgentTool>()

export function registerTool(tool: AgentTool): void {
  registry.set(tool.name, tool)
}

export function getTool(name: string): AgentTool | undefined {
  return registry.get(name)
}

export function getAllTools(): AgentTool[] {
  return [...registry.values()]
}

export function toClaudeToolDefinition(tool: AgentTool): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }
}
