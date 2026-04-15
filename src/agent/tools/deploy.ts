import { registerTool } from './index.js'
import { Client } from 'ssh2'
import { recordDeployment } from '../../db/repositories/deployments.js'
import { listProjects } from '../../db/repositories/projects-repo.js'
import { listProductLineEnvs } from '../../db/repositories/product-line-envs.js'
import { listEnvironments } from '../../db/repositories/environments-repo.js'
import { getConfig } from '../../db/repositories/system-config.js'
import { resolveSSHConfig } from './ssh-utils.js'
import { appendFileSync } from 'fs'
import type { AgentTool, TaskContext, ToolResult } from './types.js'

function deployLog(msg: string) {
  try { appendFileSync('/tmp/mcp-server.log', `[${new Date().toISOString()}] [deploy] ${msg}\n`) } catch { /* */ }
}

// ── SSH remote command execution ──────────────────────────────────────────

function sshExec(config: { host: string; port?: number; username: string; password: string }, command: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const conn = new Client()
    let stdout = ''
    let stderr = ''

    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) { conn.end(); return reject(err) }
        stream.on('close', (code: number) => {
          conn.end()
          resolve({ stdout, stderr, code: code ?? 0 })
        })
        stream.on('data', (data: Buffer) => { stdout += data.toString() })
        stream.stderr.on('data', (data: Buffer) => { stderr += data.toString() })
      })
    })
    conn.on('error', reject)
    conn.connect({
      host: config.host,
      port: config.port ?? 22,
      username: config.username,
      password: config.password,
      readyTimeout: 10000,
    })
  })
}

// ── Lookup helpers ────────────────────────────────────────────────────────

async function lookupProjectAndEnv(projectName: string, envName: string) {
  const projects = await listProjects()
  const project = projects.find(p => p.name === projectName || p.displayName === projectName)
  if (!project) throw new Error(`项目 "${projectName}" 未在数据库中注册`)

  const envs = await listEnvironments()
  const env = envs.find(e => e.name === envName || e.displayName === envName)
  if (!env) throw new Error(`环境 "${envName}" 未定义`)

  const plEnvs = await listProductLineEnvs(project.productLineId)
  const plEnv = plEnvs.find(e => e.envId === env.id)
  if (!plEnv) throw new Error(`项目所属产线未配置 "${envName}" 环境`)

  const harborCfg = await getConfig('harbor')
  const harbor = harborCfg?.value as Record<string, string> | undefined
  const sshConfig = await resolveSSHConfig(plEnv.connectionConfig)

  return { project, env, plEnv, harbor, sshConfig }
}

function buildImageFullPath(harborUrl: string, harborProject: string, imageTag: string): string {
  const registryHost = harborUrl.replace(/^https?:\/\//, '').replace(/\/$/, '')
  return `${registryHost}/${harborProject}:${imageTag}`
}

// ── Deploy Tool ──────────────────────────────────────────────────────────

const deployTool: AgentTool = {
  name: 'execute_deploy',
  description: '执行部署：SSH 到目标服务器，从 Harbor 拉取新镜像并更新容器。需要先通过审批。',
  riskLevel: 'high',
  requiredRole: 'ops',
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: '项目名称' },
      env: { type: 'string', description: '目标环境 (dev/test/staging/prod)' },
      imageTag: { type: 'string', description: '镜像标签' },
    },
    required: ['project', 'env', 'imageTag'],
  },
  async execute(params: unknown, ctx: TaskContext): Promise<ToolResult> {
    const { project: projectName, env: envName, imageTag } = params as { project: string; env: string; imageTag: string }
    deployLog(`execute_deploy: project=${projectName} env=${envName} tag=${imageTag}`)

    try {
      const { project, plEnv, harbor, sshConfig } = await lookupProjectAndEnv(projectName, envName)

      if (!sshConfig) {
        return { success: false, output: `环境 "${envName}" 未配置 SSH 连接信息（IP/用户名/密码）。请在管理后台 → 产线详情 → 环境配置中设置。` }
      }

      if (plEnv.runtime === 'docker') {
        const containerName = project.dockerContainerName || project.name
        const harborUrl = harbor?.url ?? ''
        const harborUser = harbor?.username ?? ''
        const harborPass = harbor?.password ?? ''
        const harborProject = project.harborProject || project.name

        if (!harborUrl) return { success: false, output: 'Harbor URL 未配置。请在系统配置中设置。' }

        const fullImage = buildImageFullPath(harborUrl, harborProject, imageTag)
        const registryHost = harborUrl.replace(/^https?:\/\//, '').replace(/\/$/, '')
        const composePath = project.composePath
        deployLog(`SSH to ${sshConfig.host}, container=${containerName}, image=${fullImage}, composePath=${composePath}`)

        const latestImage = `${registryHost}/${harborProject}:latest`
        let commands: string

        if (composePath) {
          // Docker Compose 部署模式
          // 先检测 compose 命令版本，后续统一使用
          commands = [
            `COMPOSE_CMD=$(docker compose version >/dev/null 2>&1 && echo "docker compose" || echo "docker-compose")`,
            `docker login -u '${harborUser}' -p '${harborPass}' ${registryHost}`,
            `cd ${composePath}`,
            `$COMPOSE_CMD stop ${containerName} || true`,
            `docker rmi ${latestImage} || true`,
            `docker pull ${fullImage}`,
            `docker tag ${fullImage} ${latestImage}`,
            `$COMPOSE_CMD up -d ${containerName}`,
          ].join(' && ')
        } else {
          // 裸 Docker 部署模式（兼容旧方式）
          commands = [
            `docker login -u '${harborUser}' -p '${harborPass}' ${registryHost}`,
            `docker stop ${containerName} || true`,
            `docker rm ${containerName} || true`,
            `docker rmi ${latestImage} || true`,
            `docker pull ${fullImage}`,
            `docker tag ${fullImage} ${latestImage}`,
            `docker run -d --name ${containerName} --restart unless-stopped ${latestImage}`,
          ].join(' && ')
        }

        const result = await sshExec({ host: sshConfig.host, port: sshConfig.port, username: sshConfig.username, password: sshConfig.password }, commands)
        deployLog(`SSH result: code=${result.code} stdout=${result.stdout.slice(0, 200)}`)

        if (result.code !== 0) {
          await recordDeployment({ project: projectName, env: envName, imageTag, deployedBy: ctx.initiatorId, status: 'failed' })
          return { success: false, output: `部署失败 (exit code ${result.code}):\n${result.stderr || result.stdout}` }
        }

        await recordDeployment({ project: projectName, env: envName, imageTag, deployedBy: ctx.initiatorId, status: 'success' })
        return { success: true, output: `✅ 部署成功\n服务器: ${sshConfig.host}\n容器: ${containerName}\n镜像: ${fullImage}` }

      } else {
        // Kubernetes
        const deploymentName = project.k8sProjectName || project.name
        const namespace = plEnv.namespace || envName
        const harborProject = project.harborProject || project.name
        const harborUrl = harbor?.url?.replace(/^https?:\/\//, '') ?? ''
        const fullImage = `${harborUrl}/${harborProject}:${imageTag}`

        const commands = [
          `kubectl set image deployment/${deploymentName} ${deploymentName}=${fullImage} --namespace=${namespace}`,
          `kubectl rollout status deployment/${deploymentName} --namespace=${namespace} --timeout=5m`,
        ].join(' && ')

        const result = await sshExec({ host: sshConfig.host, port: sshConfig.port, username: sshConfig.username, password: sshConfig.password }, commands)
        if (result.code !== 0) {
          await recordDeployment({ project: projectName, env: envName, imageTag, deployedBy: ctx.initiatorId, status: 'failed' })
          return { success: false, output: `K8s 部署失败:\n${result.stderr || result.stdout}` }
        }

        await recordDeployment({ project: projectName, env: envName, imageTag, deployedBy: ctx.initiatorId, status: 'success' })
        return { success: true, output: `✅ K8s 部署成功\nDeployment: ${deploymentName}\nNamespace: ${namespace}\n镜像: ${fullImage}` }
      }
    } catch (err) {
      deployLog(`execute_deploy error: ${String(err)}`)
      return { success: false, output: `部署错误: ${String(err)}` }
    }
  },
}

// ── Rollback Tool ────────────────────────────────────────────────────────

const rollbackTool: AgentTool = {
  name: 'execute_rollback',
  description: '回滚部署。Docker 需指定回滚目标镜像标签，K8s 自动回滚到上一版本。',
  riskLevel: 'high',
  requiredRole: 'ops',
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: '项目名称' },
      env: { type: 'string', description: '目标环境' },
      imageTag: { type: 'string', description: '回滚到的镜像标签（Docker 必填，K8s 可选）' },
    },
    required: ['project', 'env'],
  },
  async execute(params: unknown, ctx: TaskContext): Promise<ToolResult> {
    const { project: projectName, env: envName, imageTag } = params as { project: string; env: string; imageTag?: string }
    deployLog(`execute_rollback: project=${projectName} env=${envName} tag=${imageTag ?? 'auto'}`)

    try {
      const { project, plEnv, sshConfig } = await lookupProjectAndEnv(projectName, envName)
      if (!sshConfig) {
        return { success: false, output: `环境 "${envName}" 未配置 SSH 连接信息` }
      }

      if (plEnv.runtime === 'kubernetes') {
        const deploymentName = project.k8sProjectName || project.name
        const namespace = plEnv.namespace || envName
        const result = await sshExec(
          { host: sshConfig.host, port: sshConfig.port, username: sshConfig.username, password: sshConfig.password },
          `kubectl rollout undo deployment/${deploymentName} --namespace=${namespace}`
        )
        if (result.code !== 0) return { success: false, output: `回滚失败:\n${result.stderr || result.stdout}` }
        return { success: true, output: `✅ K8s 回滚成功: ${deploymentName} (${namespace})` }
      }

      // Docker: redeploy with old tag
      if (!imageTag) return { success: false, output: 'Docker 回滚需要指定目标镜像标签。请先用 query_deployments 查看历史版本。' }
      return deployTool.execute({ project: projectName, env: envName, imageTag }, ctx)
    } catch (err) {
      return { success: false, output: `回滚错误: ${String(err)}` }
    }
  },
}

// ── Restart Tool ─────────────────────────────────────────────────────────

const restartTool: AgentTool = {
  name: 'execute_restart',
  description: '重启服务。SSH 到目标服务器执行 docker restart 或 kubectl rollout restart。',
  riskLevel: 'medium',
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: '项目名称' },
      env: { type: 'string', description: '目标环境' },
    },
    required: ['project', 'env'],
  },
  async execute(params: unknown, _ctx: TaskContext): Promise<ToolResult> {
    const { project: projectName, env: envName } = params as { project: string; env: string }
    deployLog(`execute_restart: project=${projectName} env=${envName}`)

    try {
      const { project, plEnv, sshConfig } = await lookupProjectAndEnv(projectName, envName)
      if (!sshConfig) {
        return { success: false, output: `环境 "${envName}" 未配置 SSH 连接信息` }
      }

      let command: string
      if (plEnv.runtime === 'docker') {
        const containerName = project.dockerContainerName || project.name
        const composePath = project.composePath
        if (composePath) {
          command = `COMPOSE_CMD=$(docker compose version >/dev/null 2>&1 && echo "docker compose" || echo "docker-compose") && cd ${composePath} && $COMPOSE_CMD restart ${containerName}`
        } else {
          command = `docker restart ${containerName}`
        }
      } else {
        const deploymentName = project.k8sProjectName || project.name
        const namespace = plEnv.namespace || envName
        command = `kubectl rollout restart deployment/${deploymentName} --namespace=${namespace}`
      }

      const result = await sshExec({ host: sshConfig.host, port: sshConfig.port, username: sshConfig.username, password: sshConfig.password }, command)
      if (result.code !== 0) return { success: false, output: `重启失败:\n${result.stderr || result.stdout}` }
      return { success: true, output: `✅ 重启成功: ${projectName} (${envName})\n${result.stdout}` }
    } catch (err) {
      return { success: false, output: `重启错误: ${String(err)}` }
    }
  },
}

registerTool(deployTool)
registerTool(rollbackTool)
registerTool(restartTool)

export { deployTool, rollbackTool, restartTool }
