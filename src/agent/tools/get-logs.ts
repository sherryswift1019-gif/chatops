import { registerTool } from './index.js'
import { execSync } from 'child_process'
import type { AgentTool, TaskContext, ToolResult } from './types.js'

const getLogsTool: AgentTool = {
  name: 'get_logs',
  description: 'Retrieve container logs for a service and analyze them for errors. Supports both Kubernetes and Docker.',
  riskLevel: 'low',
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'Service/deployment name' },
      env: { type: 'string', description: 'Environment (used to select namespace/context)' },
      tail: { type: 'number', description: 'Last N log lines, default 200' },
      runtime: { type: 'string', enum: ['kubernetes', 'docker'], description: 'Container runtime' },
    },
    required: ['project', 'env', 'runtime'],
  },
  async execute(params: unknown, _ctx: TaskContext): Promise<ToolResult> {
    const { project, env, tail = 200, runtime } = params as {
      project: string; env: string; tail?: number; runtime: 'kubernetes' | 'docker'
    }
    try {
      let logs: string
      if (runtime === 'kubernetes') {
        logs = execSync(
          `kubectl logs deployment/${project} --namespace=${env} --tail=${tail} 2>&1`,
          { encoding: 'utf8', timeout: 15000 }
        )
      } else {
        logs = execSync(
          `docker logs ${project}-${env} --tail ${tail} 2>&1`,
          { encoding: 'utf8', timeout: 15000 }
        )
      }
      return {
        success: true,
        output: `Logs for ${project} (${env}, last ${tail} lines):\n\`\`\`\n${logs}\n\`\`\``,
        data: { logs },
      }
    } catch (err) {
      return { success: false, output: `Failed to retrieve logs: ${String(err)}` }
    }
  },
}

registerTool(getLogsTool)
export { getLogsTool }
