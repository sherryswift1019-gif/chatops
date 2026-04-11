import { getToolPermissions } from '../../db/repositories/tool-permissions.js'
import { DEFAULT_TOOL_ROLES } from './types.js'
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

export async function getPermittedTools(userRole: Role | null, productLineId?: number, envName?: string): Promise<AgentTool[]> {
  const allTools = getAllTools()
  if (!userRole) userRole = 'developer'

  // Get permission overrides for this product line
  const overrides = productLineId ? await getToolPermissions(productLineId) : []

  return allTools.filter(tool => {
    // Check for specific env override first, then wildcard, then default
    let allowedRoles: string[] | undefined

    if (envName) {
      const envSpecific = overrides.find(o => o.toolName === tool.name && o.envName === envName)
      if (envSpecific) {
        allowedRoles = envSpecific.allowedRoles
      }
    }

    if (!allowedRoles) {
      const wildcard = overrides.find(o => o.toolName === tool.name && o.envName === '*')
      if (wildcard) {
        allowedRoles = wildcard.allowedRoles
      }
    }

    if (!allowedRoles) {
      allowedRoles = DEFAULT_TOOL_ROLES[tool.name] ?? ['developer', 'tester', 'ops', 'admin']
    }

    return allowedRoles.includes(userRole!)
  })
}
