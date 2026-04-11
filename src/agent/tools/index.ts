import { getToolPermissions } from '../../db/repositories/tool-permissions.js'
import { hasRolePermission } from './types.js'
import type { Role, AgentTool } from './types.js'

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

export async function getPermittedTools(userRole: Role | null, productLineId?: number): Promise<AgentTool[]> {
  const allTools = getAllTools()

  // Get permission overrides for this product line
  const overrides = productLineId ? await getToolPermissions(productLineId) : []
  const overrideMap = new Map(overrides.map(o => [o.toolName, o.minRole]))

  return allTools.filter(tool => {
    const effectiveMinRole = overrideMap.get(tool.name) ?? tool.requiredRole ?? 'developer'
    return hasRolePermission(userRole, effectiveMinRole as Role)
  })
}
