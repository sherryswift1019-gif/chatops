import type { AgentTool, Role } from './tools/types.js'
import { DEFAULT_TOOL_ROLES } from './tools/types.js'
import { getToolPermissions } from '../db/repositories/tool-permissions.js'

const FALLBACK_ROLES = ['developer', 'tester', 'ops', 'admin']

export async function filterToolsByRole(
  tools: AgentTool[],
  role: Role | null,
  productLineId?: number,
): Promise<AgentTool[]> {
  const effectiveRole = role ?? 'developer'
  const overrides = productLineId ? await getToolPermissions(productLineId) : []

  return tools.filter(tool => {
    const override = overrides.find(o => o.toolName === tool.name && o.envName === '*')
    const allowed = override?.allowedRoles ?? DEFAULT_TOOL_ROLES[tool.name] ?? FALLBACK_ROLES
    return allowed.includes(effectiveRole)
  })
}
