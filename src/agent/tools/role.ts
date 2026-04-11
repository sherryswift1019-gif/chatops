import { registerTool } from './index.js'
import { upsertRole, getUserRole } from '../../db/repositories/roles.js'
import type { AgentTool, TaskContext, ToolResult, Role } from './types.js'

const manageRoleTool: AgentTool = {
  name: 'manage_role',
  description: '授予或撤销用户角色。仅管理员可操作。',
  riskLevel: 'high',
  requiredRole: 'admin',
  inputSchema: {
    type: 'object',
    properties: {
      targetUserId: { type: 'string', description: 'User ID to modify' },
      targetUserName: { type: 'string', description: 'Display name of the user' },
      role: { type: 'string', enum: ['developer', 'tester', 'ops', 'admin'], description: '要分配的角色' },
      action: { type: 'string', enum: ['grant', 'revoke'], description: 'Grant or revoke the role' },
    },
    required: ['targetUserId', 'targetUserName', 'role', 'action'],
  },
  async execute(params: unknown, ctx: TaskContext): Promise<ToolResult> {
    const { targetUserId, targetUserName, role, action } = params as {
      targetUserId: string; targetUserName: string; role: Role; action: 'grant' | 'revoke'
    }

    const callerRole = await getUserRole(ctx.platform, ctx.initiatorId, ctx.groupId)
    if (callerRole !== 'admin') {
      return { success: false, output: '❌ Only admins can manage roles.' }
    }

    if (action === 'grant') {
      await upsertRole({
        platform: ctx.platform,
        userId: targetUserId,
        userName: targetUserName,
        role,
        groupId: ctx.groupId,
        createdBy: ctx.initiatorId,
      })
      return { success: true, output: `✅ Granted ${role} role to ${targetUserName}` }
    } else {
      await upsertRole({
        platform: ctx.platform,
        userId: targetUserId,
        userName: targetUserName,
        role: 'developer',
        groupId: ctx.groupId,
        createdBy: ctx.initiatorId,
      })
      return { success: true, output: `✅ Revoked ${role} from ${targetUserName} (reset to developer)` }
    }
  },
}

registerTool(manageRoleTool)
export { manageRoleTool }
