import { registerTool } from './index.js'
import type { AgentTool, TaskContext, ToolResult } from './types.js'

export interface ApprovalMeta {
  groupId: string
  platform: string
  initiatorId: string
  initiatorRole?: string
  productLineId?: number
  originalPrompt: string
  lockProject?: string
  lockEnv?: string
}

let gateRequestFn: ((taskId: string, action: string, env: string, description: string, meta: ApprovalMeta) => Promise<void>) | null = null

export function setApprovalGateHandler(
  fn: (taskId: string, action: string, env: string, description: string, meta: ApprovalMeta) => Promise<void>
): void {
  gateRequestFn = fn
}

const approvalTool: AgentTool = {
  name: 'request_approval',
  description: '在执行高危操作前请求人工审批。在调用 execute_deploy、execute_rollback 或任何生产变更之前先调用本工具。调用后当前会话结束,审批通过后在新会话中再继续执行。',
  riskLevel: 'low',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'Action type: deploy, rollback, restart' },
      env: { type: 'string', description: 'Target environment' },
      description: { type: 'string', description: 'Human-readable description of what will be done' },
    },
    required: ['action', 'env', 'description'],
  },
  async execute(params: unknown, ctx: TaskContext): Promise<ToolResult> {
    const { action, env, description } = params as { action: string; env: string; description: string }
    if (!gateRequestFn) {
      return { success: false, output: 'Approval gate not configured' }
    }
    await gateRequestFn(ctx.taskId, action, env, description, {
      groupId: ctx.groupId,
      platform: ctx.platform ?? 'dingtalk',
      initiatorId: ctx.initiatorId,
      initiatorRole: ctx.initiatorRole ?? undefined,
      productLineId: ctx.productLineId,
      originalPrompt: ctx.originalPrompt ?? '',
    })
    return {
      success: true,
      output: `Approval request sent. The operation will proceed once an authorized approver confirms. Session ending — I will continue after approval is received.`,
    }
  },
}

registerTool(approvalTool)
export { approvalTool }
