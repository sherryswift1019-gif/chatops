import type { IMAdapter } from '../../adapters/im/types.js'

export type RiskLevel = 'low' | 'medium' | 'high'
export type Role = 'developer' | 'tester' | 'ops' | 'admin'

export interface TaskContext {
  taskId: string
  groupId: string
  platform: string
  initiatorId: string
  initiatorRole: Role | null
  cwd?: string  // worktree 工作目录（分析/修复 Agent 用）
  productLineId?: number  // 产品线 ID
  originalPrompt?: string
  /** 节点级容器名，run_command 等本地命令工具看到非空时走 docker exec */
  dockerContainerName?: string
  /** IM 消息原文（e2e_run handler 解析命令用） */
  messageText?: string
  /** IM 适配器实例（e2e_run handler 发送群消息用） */
  adapter?: IMAdapter
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
  check_environment_status: ['developer', 'tester', 'ops', 'admin'],
  list_images: ['developer', 'tester', 'ops', 'admin'],
  list_gitlab_branches: ['developer', 'tester', 'ops', 'admin'],
  get_gitlab_commits: ['developer', 'tester', 'ops', 'admin'],
  get_logs: ['developer', 'tester', 'ops', 'admin'],
  execute_deploy: ['ops', 'admin'],
  execute_rollback: ['ops', 'admin'],
  execute_restart: ['ops', 'admin'],
  request_approval: ['developer', 'tester', 'ops', 'admin'],
  manage_role: ['admin'],
  list_product_line_projects: ['developer', 'tester', 'ops', 'admin'],
  list_artifacts: ['developer', 'tester', 'ops', 'admin'],
  get_pipeline_artifact_inputs: ['developer', 'tester', 'ops', 'admin'],

  // 研发 AI 助手工具
  read_code: ['developer', 'tester', 'ops', 'admin'],
  download_image: ['developer', 'tester', 'ops', 'admin'],
  switch_version: ['developer', 'tester', 'ops', 'admin'],
  create_issue: ['developer', 'tester', 'ops', 'admin'],
  search_knowledge: ['developer', 'tester', 'ops', 'admin'],

  // 修复 Agent 工具（系统内部触发，不直接暴露给用户）
  fix_code: ['developer', 'ops', 'admin'],
  run_tests: ['developer', 'tester', 'ops', 'admin'],
  run_command: ['developer', 'tester', 'ops', 'admin'],
  run_remote_command: ['admin'],
  create_mr: ['developer', 'ops', 'admin'],
  update_ai_summary: ['developer', 'ops', 'admin'],

  // Review Agent 工具
  review_mr_diff: ['developer', 'tester', 'ops', 'admin'],

  // PRD Agent 工具
  save_prd: ['developer', 'tester', 'ops', 'admin'],
  read_prd: ['developer', 'tester', 'ops', 'admin'],
  update_prd_context: ['developer', 'tester', 'ops', 'admin'],
  search_existing_prds: ['developer', 'tester', 'ops', 'admin'],
  submit_review: ['developer', 'tester', 'ops', 'admin'],

  // 架构设计 Agent 工具
  save_arch: ['developer', 'tester', 'ops', 'admin'],
  read_arch: ['developer', 'tester', 'ops', 'admin'],
  update_arch_context: ['developer', 'tester', 'ops', 'admin'],
  search_existing_arch: ['developer', 'tester', 'ops', 'admin'],
}
