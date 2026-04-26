import { registerTool } from './index.js'
import { getRecentDeployments } from '../../db/repositories/deployments.js'
import type { AgentTool, TaskContext, ToolResult } from './types.js'

const queryDeploymentsTool: AgentTool = {
  name: 'query_deployments',
  description: '查询某模块最近的部署历史,用于查看当前部署的版本或回顾历史部署记录。',
  riskLevel: 'low',
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'Project/service name' },
      env: { type: 'string', description: 'Environment (dev/staging/prod), optional' },
    },
    required: ['project'],
  },
  async execute(params: unknown, _ctx: TaskContext): Promise<ToolResult> {
    const { project, env } = params as { project: string; env?: string }
    const deployments = await getRecentDeployments(project, env, 5)
    if (deployments.length === 0) {
      return { success: true, output: `No deployments found for ${project}${env ? ` in ${env}` : ''}` }
    }
    const lines = deployments.map(d =>
      `- ${d.env} | ${d.imageTag} | ${d.deployedAt.toISOString()} | ${d.status} | by ${d.deployedBy}`
    )
    return { success: true, output: `Recent deployments for ${project}:\n${lines.join('\n')}`, data: deployments }
  },
}

// Retained for two-week rollback window. Do not re-enable without restoring the
// import in mcp-server.ts and server.ts. Rolling back also requires UPDATE
// capabilities SET tool_names = '["query_deployments"]' WHERE key = 'view_deployments'.
// registerTool(queryDeploymentsTool)
export { queryDeploymentsTool }
