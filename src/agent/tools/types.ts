export type RiskLevel = 'low' | 'medium' | 'high'
export type Role = 'developer' | 'tester' | 'ops' | 'admin'

export interface TaskContext {
  taskId: string
  groupId: string
  platform: string
  initiatorId: string
  initiatorRole: Role | null
  productLineId?: number
  originalPrompt?: string
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

export const DEFAULT_TOOL_ROLES: Record<string, Role[]> = {
  query_deployments: ['developer', 'tester', 'ops', 'admin'],
  list_images: ['developer', 'tester', 'ops', 'admin'],
  get_gitlab_commits: ['developer', 'tester', 'ops', 'admin'],
  get_logs: ['developer', 'tester', 'ops', 'admin'],
  execute_deploy: ['ops', 'admin'],
  execute_rollback: ['ops', 'admin'],
  execute_restart: ['ops', 'admin'],
  request_approval: ['developer', 'tester', 'ops', 'admin'],
  manage_role: ['admin'],
  list_product_line_projects: ['developer', 'tester', 'ops', 'admin'],
  list_artifacts: ['developer', 'tester', 'ops', 'admin'],
}
