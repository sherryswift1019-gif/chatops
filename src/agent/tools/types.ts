export type RiskLevel = 'low' | 'medium' | 'high'
export type Role = 'developer' | 'ops' | 'admin'

export interface TaskContext {
  taskId: string
  groupId: string
  platform: string
  initiatorId: string
  initiatorRole: Role | null
}

export interface ToolResult {
  success: boolean
  output: string
  data?: unknown
}

export interface AgentTool {
  readonly name: string
  readonly description: string
  readonly riskLevel: RiskLevel
  readonly requiredRole?: Role
  readonly inputSchema: Record<string, unknown>
  execute(params: unknown, context: TaskContext): Promise<ToolResult>
}

export const ROLE_HIERARCHY: Record<Role, number> = {
  developer: 0,
  ops: 1,
  admin: 2,
}

export function hasRolePermission(userRole: Role | null, requiredRole: Role): boolean {
  if (!userRole) return requiredRole === 'developer'
  return ROLE_HIERARCHY[userRole] >= ROLE_HIERARCHY[requiredRole]
}
