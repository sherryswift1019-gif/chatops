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
