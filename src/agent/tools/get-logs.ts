import { registerTool } from './index.js'
import { Client } from 'ssh2'
import { listProjects } from '../../db/repositories/projects-repo.js'
import { listProductLineEnvs } from '../../db/repositories/product-line-envs.js'
import { listEnvironments } from '../../db/repositories/environments-repo.js'
import { resolveSSHConfig } from './ssh-utils.js'
import { appendFileSync } from 'fs'
import type { AgentTool, TaskContext, ToolResult } from './types.js'

function toolLog(msg: string) {
  try { appendFileSync('/tmp/mcp-server.log', `[${new Date().toISOString()}] [get_logs] ${msg}\n`) } catch { /* */ }
}

function sshExec(config: { host: string; port?: number; username: string; password: string }, command: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const conn = new Client()
    let stdout = ''
    let stderr = ''
    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) { conn.end(); return reject(err) }
        stream.on('close', (code: number) => { conn.end(); resolve({ stdout, stderr, code: code ?? 0 }) })
        stream.on('data', (data: Buffer) => { stdout += data.toString() })
        stream.stderr.on('data', (data: Buffer) => { stderr += data.toString() })
      })
    })
    conn.on('error', reject)
    conn.connect({ host: config.host, port: config.port ?? 22, username: config.username, password: config.password, readyTimeout: 10000 })
  })
}

const getLogsTool: AgentTool = {
  name: 'get_logs',
  description: '获取容器日志。SSH 到目标服务器读取 Docker 或 K8s 日志。获取到日志后，必须将完整的原始日志内容直接发送给用户，不要总结、不要省略、不要分析，原样输出。',
  riskLevel: 'low',
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: '项目名称' },
      env: { type: 'string', description: '环境 (dev/test/staging/prod)' },
      tail: { type: 'number', description: '最后 N 行日志，默认 200' },
    },
    required: ['project', 'env'],
  },
  async execute(params: unknown, _ctx: TaskContext): Promise<ToolResult> {
    const { project: projectName, env: envName, tail = 200 } = params as { project: string; env: string; tail?: number }
    toolLog(`get_logs: project=${projectName} env=${envName} tail=${tail}`)

    try {
      // 查项目
      const projects = await listProjects()
      const project = projects.find(p => p.name === projectName || p.displayName === projectName)
      if (!project) return { success: false, output: `项目 "${projectName}" 未在数据库中注册` }

      // 查环境
      const envs = await listEnvironments()
      const env = envs.find(e => e.name === envName || e.displayName === envName)
      if (!env) return { success: false, output: `环境 "${envName}" 未定义` }

      // 查产线环境配置
      const plEnvs = await listProductLineEnvs(project.productLineId)
      const plEnv = plEnvs.find(e => e.envId === env.id)
      if (!plEnv) return { success: false, output: `项目所属产线未配置 "${envName}" 环境` }

      const sshConfig = await resolveSSHConfig(plEnv.connectionConfig)
      if (!sshConfig) {
        return { success: false, output: `环境 "${envName}" 未配置 SSH 连接信息` }
      }

      let command: string
      if (plEnv.runtime === 'docker') {
        const containerName = project.dockerContainerName || project.name
        const composePath = project.composePath
        if (composePath) {
          command = `COMPOSE_CMD=$(docker compose version >/dev/null 2>&1 && echo "docker compose" || echo "docker-compose") && cd ${composePath} && $COMPOSE_CMD logs --tail ${tail} ${containerName}`
        } else {
          command = `docker logs ${containerName} --tail ${tail} 2>&1`
        }
      } else {
        const deploymentName = project.k8sProjectName || project.name
        const namespace = plEnv.namespace || envName
        command = `kubectl logs deployment/${deploymentName} --namespace=${namespace} --tail=${tail} 2>&1`
      }

      toolLog(`SSH to ${sshConfig.host}, command: ${command}`)
      const result = await sshExec({ host: sshConfig.host, port: sshConfig.port, username: sshConfig.username, password: sshConfig.password }, command)

      const logs = result.stdout || result.stderr
      if (result.code !== 0 && !logs) {
        return { success: false, output: `日志获取失败 (exit code ${result.code}):\n${result.stderr}` }
      }

      return {
        success: true,
        output: `${projectName} (${envName}) 最近 ${tail} 行日志:\n\`\`\`\n${logs}\n\`\`\``,
      }
    } catch (err) {
      toolLog(`get_logs error: ${String(err)}`)
      return { success: false, output: `日志获取错误: ${String(err)}` }
    }
  },
}

registerTool(getLogsTool)
export { getLogsTool }
