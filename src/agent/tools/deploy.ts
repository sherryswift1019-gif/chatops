import { registerTool } from './index.js'
import { execSync } from 'child_process'
import { recordDeployment } from '../../db/repositories/deployments.js'
import type { AgentTool, TaskContext, ToolResult } from './types.js'

const deployTool: AgentTool = {
  name: 'execute_deploy',
  description: 'Execute a deployment. Only call this tool after explicit human approval has been obtained via request_approval tool. The deployment has already been approved.',
  riskLevel: 'high',
  requiredRole: 'ops',
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string' },
      env: { type: 'string' },
      imageTag: { type: 'string' },
      runtime: { type: 'string', enum: ['kubernetes', 'docker'] },
      approvedBy: { type: 'string' },
    },
    required: ['project', 'env', 'imageTag', 'runtime', 'approvedBy'],
  },
  async execute(params: unknown, ctx: TaskContext): Promise<ToolResult> {
    const { project, env, imageTag, runtime, approvedBy } = params as {
      project: string; env: string; imageTag: string; runtime: 'kubernetes' | 'docker'; approvedBy: string
    }
    try {
      if (runtime === 'kubernetes') {
        execSync(
          `kubectl set image deployment/${project} ${project}=${project}:${imageTag} --namespace=${env}`,
          { encoding: 'utf8', timeout: 60000 }
        )
        execSync(
          `kubectl rollout status deployment/${project} --namespace=${env} --timeout=5m`,
          { encoding: 'utf8', timeout: 320000 }
        )
      } else {
        execSync(
          `docker pull ${project}:${imageTag} && docker stop ${project}-${env} || true && docker run -d --name ${project}-${env} --rm ${project}:${imageTag}`,
          { encoding: 'utf8', timeout: 120000 }
        )
      }
      await recordDeployment({
        project, env, imageTag,
        deployedBy: ctx.initiatorId,
        approvedBy,
        status: 'success',
      })
      return { success: true, output: `✅ Successfully deployed ${project}:${imageTag} to ${env}` }
    } catch (err) {
      await recordDeployment({
        project, env, imageTag,
        deployedBy: ctx.initiatorId,
        approvedBy,
        status: 'failed',
      })
      return { success: false, output: `❌ Deployment failed: ${String(err)}` }
    }
  },
}

const rollbackTool: AgentTool = {
  name: 'execute_rollback',
  description: 'Roll back a deployment to the previous version. Only call after explicit human approval.',
  riskLevel: 'high',
  requiredRole: 'ops',
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string' },
      env: { type: 'string' },
      runtime: { type: 'string', enum: ['kubernetes', 'docker'] },
      approvedBy: { type: 'string' },
    },
    required: ['project', 'env', 'runtime', 'approvedBy'],
  },
  async execute(params: unknown, _ctx: TaskContext): Promise<ToolResult> {
    const { project, env, runtime } = params as {
      project: string; env: string; runtime: 'kubernetes' | 'docker'
    }
    try {
      if (runtime === 'kubernetes') {
        execSync(`kubectl rollout undo deployment/${project} --namespace=${env}`, { encoding: 'utf8', timeout: 60000 })
        execSync(`kubectl rollout status deployment/${project} --namespace=${env} --timeout=5m`, { encoding: 'utf8', timeout: 320000 })
      } else {
        return { success: false, output: 'Docker rollback requires manual intervention — no previous container image tracked.' }
      }
      return { success: true, output: `✅ Rolled back ${project} in ${env}` }
    } catch (err) {
      return { success: false, output: `❌ Rollback failed: ${String(err)}` }
    }
  },
}

const restartTool: AgentTool = {
  name: 'execute_restart',
  description: 'Restart a service. For staging/prod, approval is required first.',
  riskLevel: 'medium',
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string' },
      env: { type: 'string' },
      runtime: { type: 'string', enum: ['kubernetes', 'docker'] },
    },
    required: ['project', 'env', 'runtime'],
  },
  async execute(params: unknown, _ctx: TaskContext): Promise<ToolResult> {
    const { project, env, runtime } = params as { project: string; env: string; runtime: 'kubernetes' | 'docker' }
    try {
      if (runtime === 'kubernetes') {
        execSync(`kubectl rollout restart deployment/${project} --namespace=${env}`, { encoding: 'utf8', timeout: 30000 })
      } else {
        execSync(`docker restart ${project}-${env}`, { encoding: 'utf8', timeout: 30000 })
      }
      return { success: true, output: `✅ Restarted ${project} in ${env}` }
    } catch (err) {
      return { success: false, output: `❌ Restart failed: ${String(err)}` }
    }
  },
}

registerTool(deployTool)
registerTool(rollbackTool)
registerTool(restartTool)

export { deployTool, rollbackTool, restartTool }
