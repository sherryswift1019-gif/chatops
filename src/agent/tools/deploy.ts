import { registerTool } from './index.js'
import { Client } from 'ssh2'
import { recordDeployment } from '../../db/repositories/deployments.js'
import { listProjects } from '../../db/repositories/projects-repo.js'
import { listProductLineEnvs } from '../../db/repositories/product-line-envs.js'
import { listEnvironments } from '../../db/repositories/environments-repo.js'
import { getConfig } from '../../db/repositories/system-config.js'
import { resolveSSHConfig, resolveComposeFile } from './ssh-utils.js'
import { appendFileSync } from 'fs'
import axios from 'axios'
import https from 'https'
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
  if (!project) throw new Error(`模块 "${projectName}" 未在数据库中注册`)

  const envs = await listEnvironments()
  const env = envs.find(e => e.name === envName || e.displayName === envName)
  if (!env) throw new Error(`环境 "${envName}" 未定义`)

  const plEnvs = await listProductLineEnvs(project.productLineId)
  const plEnv = plEnvs.find(e => e.envId === env.id)
  if (!plEnv) throw new Error(`模块所属产线未配置 "${envName}" 环境`)

  const harborCfg = await getConfig('harbor')
  const harbor = harborCfg?.value as Record<string, string> | undefined
  const sshConfig = await resolveSSHConfig(plEnv.connectionConfig)

  return { project, env, plEnv, harbor, sshConfig }
}

function buildImageFullPath(harborUrl: string, harborProject: string, imageTag: string): string {
  const registryHost = harborUrl.replace(/^https?:\/\//, '').replace(/\/$/, '')
  return `${registryHost}/${harborProject}:${imageTag}`
}

// ── GitLab branch → commit 解析 ─────────────────────────────────────────

async function getGitLabConfig(): Promise<{ url: string; token: string; skipTlsVerify: boolean }> {
  const cfg = await getConfig('gitlab')
  if (!cfg) return { url: '', token: '', skipTlsVerify: false }
  const v = cfg.value as Record<string, string>
  return {
    url: v.url ?? '',
    token: v.token ?? '',
    skipTlsVerify: v.skipTlsVerify === 'true' || v.skipTlsVerify === true as unknown as string,
  }
}

async function listGitLabBranches(gitlabPath: string): Promise<string[]> {
  const gitlab = await getGitLabConfig()
  if (!gitlab.url || !gitlab.token) return []
  const encodedProject = encodeURIComponent(gitlabPath)
  const agent = gitlab.skipTlsVerify ? new https.Agent({ rejectUnauthorized: false }) : undefined
  try {
    const res = await axios.get<Array<{ name: string }>>(
      `${gitlab.url}/api/v4/projects/${encodedProject}/repository/branches`,
      { headers: { 'PRIVATE-TOKEN': gitlab.token }, httpsAgent: agent, timeout: 10000, params: { per_page: 50 } }
    )
    return res.data.map(b => b.name)
  } catch {
    return []
  }
}

async function resolveImageTag(gitlabPath: string, branch: string): Promise<{ tag: string; commitId: string; shortId: string }> {
  const gitlab = await getGitLabConfig()
  if (!gitlab.url || !gitlab.token) throw new Error('GitLab 未配置（url/token）。请在系统配置中设置。')

  const encodedProject = encodeURIComponent(gitlabPath)
  const encodedBranch = encodeURIComponent(branch)
  const agent = gitlab.skipTlsVerify ? new https.Agent({ rejectUnauthorized: false }) : undefined

  try {
    const res = await axios.get<{ commit: { id: string; short_id: string; message: string } }>(
      `${gitlab.url}/api/v4/projects/${encodedProject}/repository/branches/${encodedBranch}`,
      { headers: { 'PRIVATE-TOKEN': gitlab.token }, httpsAgent: agent, timeout: 10000 }
    )
    const shortId = res.data.commit.short_id.slice(0, 8)
    const tag = `${branch}_${shortId}`
    deployLog(`resolveImageTag: ${gitlabPath} branch=${branch} → commit=${shortId} → tag=${tag}`)
    return { tag, commitId: res.data.commit.id, shortId }
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } })?.response?.status
    if (status === 404) {
      // 查询该项目所有分支，帮用户找到正确分支名
      const branchList = await listGitLabBranches(gitlabPath)
      const hint = branchList.length > 0
        ? `\n\n该模块可用分支:\n${branchList.map(b => `- ${b}`).join('\n')}`
        : ''
      throw new Error(`GitLab 分支 "${branch}" 不存在（模块: ${gitlabPath}）${hint}`)
    }
    throw new Error(`GitLab 查询失败: ${String(err)}`)
  }
}

async function verifyImageExists(harborUrl: string, harborProject: string, tag: string): Promise<boolean> {
  const harborCfg = await getConfig('harbor')
  const harbor = harborCfg?.value as Record<string, string> | undefined
  const username = harbor?.username ?? ''
  const password = harbor?.password ?? ''
  const skipTls = harbor?.skipTlsVerify === 'true'
  const agent = skipTls ? new https.Agent({ rejectUnauthorized: false }) : undefined

  const [projectName, repoName] = harborProject.includes('/') ? harborProject.split('/') : [harborProject, harborProject]
  const url = `${harborUrl}/api/v2.0/projects/${projectName}/repositories/${encodeURIComponent(repoName)}/artifacts/${encodeURIComponent(tag)}`

  try {
    await axios.get(url, {
      headers: username ? { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` } : {},
      httpsAgent: agent,
      timeout: 10000,
    })
    return true
  } catch {
    return false
  }
}

// ── Deploy Tool ──────────────────────────────────────────────────────────

const deployTool: AgentTool = {
  name: 'execute_deploy',
  description: '执行部署。根据 Git 分支名查 GitLab 最新 commit，构造镜像 tag（格式：分支名_commitId前8位），验证 Harbor 中镜像存在后 SSH 部署。',
  riskLevel: 'high',
  requiredRole: 'ops',
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: '模块名称' },
      env: { type: 'string', description: '目标环境 (dev/test/staging/prod)' },
      branch: { type: 'string', description: 'Git 分支名，如 develop、main、release' },
    },
    required: ['project', 'env', 'branch'],
  },
  async execute(params: unknown, ctx: TaskContext): Promise<ToolResult> {
    const { project: projectName, env: envName, branch } = params as { project: string; env: string; branch: string }
    deployLog(`execute_deploy: project=${projectName} env=${envName} branch=${branch}`)

    try {
      const { project, plEnv, harbor, sshConfig } = await lookupProjectAndEnv(projectName, envName)

      if (!sshConfig) {
        return { success: false, output: `环境 "${envName}" 未配置 SSH 连接信息（IP/用户名/密码）。请在管理后台 → 产线详情 → 环境配置中设置。` }
      }

      // 通过 GitLab 解析分支最新 commit → 镜像 tag
      if (!project.gitlabPath) {
        return { success: false, output: `模块 "${projectName}" 未配置 GitLab 路径。请在管理后台的模块配置中设置 gitlabPath。` }
      }
      const harborUrl = harbor?.url ?? ''
      const harborProject = project.harborProject || project.name
      if (!harborUrl) return { success: false, output: 'Harbor URL 未配置。请在系统配置中设置。' }

      const resolved = await resolveImageTag(project.gitlabPath, branch)
      const imageTag = resolved.tag
      const resolveInfo = `\n分支: ${branch}\n提交: ${resolved.shortId}`

      const exists = await verifyImageExists(harborUrl, harborProject, imageTag)
      if (!exists) {
        return {
          success: false,
          output: `⚠️ 镜像 ${imageTag} 在 Harbor 中不存在。\n\n分支 "${branch}" 最新提交: ${resolved.shortId}\n该提交可能尚未编译成功，或 CI 流水线未触发。\n\n请检查 GitLab CI 状态后重试。`,
        }
      }

      if (plEnv.runtime === 'docker') {
        const containerName = project.dockerContainerName || project.name
        const harborUser = harbor?.username ?? ''
        const harborPass = harbor?.password ?? ''

        const fullImage = buildImageFullPath(harborUrl, harborProject, imageTag)
        const registryHost = harborUrl.replace(/^https?:\/\//, '').replace(/\/$/, '')
        const composePath = project.composePath
        deployLog(`SSH to ${sshConfig.host}, container=${containerName}, image=${fullImage}, composePath=${composePath}`)

        const latestImage = `${registryHost}/${harborProject}:latest`
        const prevImage = `${registryHost}/${harborProject}:prev`
        const repoPath = `${registryHost}/${harborProject}`
        let commands: string

        if (composePath) {
          // Docker Compose 部署模式
          const composeFile = resolveComposeFile(composePath)
          commands = [
            `COMPOSE_CMD=$(docker compose version >/dev/null 2>&1 && echo "docker compose" || echo "docker-compose")`,
            `docker login -u '${harborUser}' -p '${harborPass}' ${registryHost}`,
            `$COMPOSE_CMD -f '${composeFile}' stop ${containerName} || true`,
            // 备份当前版本用于回滚
            `docker tag ${latestImage} ${prevImage} 2>/dev/null || true`,
            `docker rmi ${latestImage} 2>/dev/null || true`,
            `docker pull ${fullImage}`,
            `docker tag ${fullImage} ${latestImage}`,
            `$COMPOSE_CMD -f '${composeFile}' up -d ${containerName}`,
            // 清理多余镜像（只保留 :latest 和 :prev）
            `docker images ${repoPath} --format '{{.Repository}}:{{.Tag}}' | grep -v ':latest$' | grep -v ':prev$' | grep -v '<none>' | xargs -r docker rmi 2>/dev/null || true`,
          ].join(' && ')
        } else {
          // 裸 Docker 部署模式（兼容旧方式）
          commands = [
            `docker login -u '${harborUser}' -p '${harborPass}' ${registryHost}`,
            `docker stop ${containerName} || true`,
            `docker rm ${containerName} || true`,
            // 备份当前版本用于回滚
            `docker tag ${latestImage} ${prevImage} 2>/dev/null || true`,
            `docker rmi ${latestImage} 2>/dev/null || true`,
            `docker pull ${fullImage}`,
            `docker tag ${fullImage} ${latestImage}`,
            `docker run -d --name ${containerName} --restart unless-stopped ${latestImage}`,
            // 清理多余镜像
            `docker images ${repoPath} --format '{{.Repository}}:{{.Tag}}' | grep -v ':latest$' | grep -v ':prev$' | grep -v '<none>' | xargs -r docker rmi 2>/dev/null || true`,
          ].join(' && ')
        }

        const result = await sshExec({ host: sshConfig.host, port: sshConfig.port, username: sshConfig.username, password: sshConfig.password }, commands)
        deployLog(`SSH result: code=${result.code} stdout=${result.stdout.slice(0, 200)}`)

        if (result.code !== 0) {
          await recordDeployment({ project: projectName, env: envName, imageTag, deployedBy: ctx.initiatorId, status: 'failed' })
          return { success: false, output: `部署失败 (exit code ${result.code}):\n${result.stderr || result.stdout}` }
        }

        await recordDeployment({ project: projectName, env: envName, imageTag, deployedBy: ctx.initiatorId, status: 'success' })
        return { success: true, output: `✅ 部署成功\n服务器: ${sshConfig.host}\n容器: ${containerName}\n镜像: ${fullImage}${resolveInfo}` }

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
  description: '回滚部署。Docker 默认使用本地 :prev 镜像秒级回滚；也可指定镜像标签从 Harbor 拉取。K8s 自动回滚到上一版本。',
  riskLevel: 'high',
  requiredRole: 'ops',
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: '模块名称' },
      env: { type: 'string', description: '目标环境' },
      imageTag: { type: 'string', description: '回滚到的镜像标签（Docker 必填，K8s 可选）' },
    },
    required: ['project', 'env'],
  },
  async execute(params: unknown, ctx: TaskContext): Promise<ToolResult> {
    const { project: projectName, env: envName, imageTag } = params as { project: string; env: string; imageTag?: string }
    deployLog(`execute_rollback: project=${projectName} env=${envName} tag=${imageTag ?? 'auto'}`)

    try {
      const { project, plEnv, sshConfig, harbor } = await lookupProjectAndEnv(projectName, envName)
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
      if (!imageTag) {
        // 尝试用本地 :prev 镜像快速回滚（秒级，不依赖 Harbor 网络）
        const harborCfg = await getConfig('harbor')
        const harbor = harborCfg?.value as Record<string, string> | undefined
        const harborUrl = harbor?.url ?? ''
        const registryHost = harborUrl.replace(/^https?:\/\//, '').replace(/\/$/, '')
        const harborProject = project.harborProject || project.name
        const prevImage = `${registryHost}/${harborProject}:prev`
        const latestImage = `${registryHost}/${harborProject}:latest`
        const containerName = project.dockerContainerName || project.name
        const composePath = project.composePath

        let commands: string
        if (composePath) {
          const composeFile = resolveComposeFile(composePath)
          commands = [
            `COMPOSE_CMD=$(docker compose version >/dev/null 2>&1 && echo "docker compose" || echo "docker-compose")`,
            `docker inspect ${prevImage} >/dev/null 2>&1 || (echo "NO_PREV" && exit 1)`,
            // 交换 :latest ↔ :prev
            `docker tag ${latestImage} ${registryHost}/${harborProject}:rollback_tmp 2>/dev/null || true`,
            `docker tag ${prevImage} ${latestImage}`,
            `docker tag ${registryHost}/${harborProject}:rollback_tmp ${prevImage} 2>/dev/null || true`,
            `docker rmi ${registryHost}/${harborProject}:rollback_tmp 2>/dev/null || true`,
            `$COMPOSE_CMD -f '${composeFile}' up -d ${containerName}`,
          ].join(' && ')
        } else {
          commands = [
            `docker inspect ${prevImage} >/dev/null 2>&1 || (echo "NO_PREV" && exit 1)`,
            `docker tag ${latestImage} ${registryHost}/${harborProject}:rollback_tmp 2>/dev/null || true`,
            `docker tag ${prevImage} ${latestImage}`,
            `docker tag ${registryHost}/${harborProject}:rollback_tmp ${prevImage} 2>/dev/null || true`,
            `docker rmi ${registryHost}/${harborProject}:rollback_tmp 2>/dev/null || true`,
            `docker stop ${containerName} || true`,
            `docker rm ${containerName} || true`,
            `docker run -d --name ${containerName} --restart unless-stopped ${latestImage}`,
          ].join(' && ')
        }

        deployLog(`rollback using local :prev image for ${projectName}`)
        const result = await sshExec(
          { host: sshConfig.host, port: sshConfig.port, username: sshConfig.username, password: sshConfig.password },
          commands
        )
        if (result.stdout.includes('NO_PREV') || result.code !== 0) {
          return { success: false, output: '本地无上一版本镜像（:prev）。请指定镜像标签回滚，如：imageTag="develop_latest"。可用 check_environment_status 查看环境状态。' }
        }
        await recordDeployment({ project: projectName, env: envName, imageTag: 'prev', deployedBy: ctx.initiatorId, status: 'rolled_back' })
        return { success: true, output: `✅ 快速回滚成功（使用本地 :prev 镜像）\n服务器: ${sshConfig.host}\n容器: ${containerName}` }
      }

      // Docker: 使用指定 imageTag 直接 SSH 部署（不走 branch 解析）
      const harborUrl = harbor?.url ?? ''
      if (!harborUrl) return { success: false, output: 'Harbor URL 未配置。请在系统配置中设置。' }
      const harborUser = harbor?.username ?? ''
      const harborPass = harbor?.password ?? ''
      const harborProject = project.harborProject || project.name
      const registryHost = harborUrl.replace(/^https?:\/\//, '').replace(/\/$/, '')
      const fullImage = buildImageFullPath(harborUrl, harborProject, imageTag)
      const containerName = project.dockerContainerName || project.name
      const composePath = project.composePath
      const latestImage = `${registryHost}/${harborProject}:latest`
      const prevImage = `${registryHost}/${harborProject}:prev`
      const repoPath = `${registryHost}/${harborProject}`

      let commands: string
      if (composePath) {
        const composeFile = resolveComposeFile(composePath)
        commands = [
          `COMPOSE_CMD=$(docker compose version >/dev/null 2>&1 && echo "docker compose" || echo "docker-compose")`,
          `docker login -u '${harborUser}' -p '${harborPass}' ${registryHost}`,
          `$COMPOSE_CMD -f '${composeFile}' stop ${containerName} || true`,
          `docker tag ${latestImage} ${prevImage} 2>/dev/null || true`,
          `docker rmi ${latestImage} 2>/dev/null || true`,
          `docker pull ${fullImage}`,
          `docker tag ${fullImage} ${latestImage}`,
          `$COMPOSE_CMD -f '${composeFile}' up -d ${containerName}`,
          `docker images ${repoPath} --format '{{.Repository}}:{{.Tag}}' | grep -v ':latest$' | grep -v ':prev$' | grep -v '<none>' | xargs -r docker rmi 2>/dev/null || true`,
        ].join(' && ')
      } else {
        commands = [
          `docker login -u '${harborUser}' -p '${harborPass}' ${registryHost}`,
          `docker stop ${containerName} || true`,
          `docker rm ${containerName} || true`,
          `docker tag ${latestImage} ${prevImage} 2>/dev/null || true`,
          `docker rmi ${latestImage} 2>/dev/null || true`,
          `docker pull ${fullImage}`,
          `docker tag ${fullImage} ${latestImage}`,
          `docker run -d --name ${containerName} --restart unless-stopped ${latestImage}`,
          `docker images ${repoPath} --format '{{.Repository}}:{{.Tag}}' | grep -v ':latest$' | grep -v ':prev$' | grep -v '<none>' | xargs -r docker rmi 2>/dev/null || true`,
        ].join(' && ')
      }

      deployLog(`rollback with specific tag ${imageTag} for ${projectName}`)
      const result = await sshExec({ host: sshConfig.host, port: sshConfig.port, username: sshConfig.username, password: sshConfig.password }, commands)
      if (result.code !== 0) {
        await recordDeployment({ project: projectName, env: envName, imageTag, deployedBy: ctx.initiatorId, status: 'failed' })
        return { success: false, output: `回滚失败 (exit code ${result.code}):\n${result.stderr || result.stdout}` }
      }
      await recordDeployment({ project: projectName, env: envName, imageTag, deployedBy: ctx.initiatorId, status: 'rolled_back' })
      return { success: true, output: `✅ 回滚成功\n服务器: ${sshConfig.host}\n容器: ${containerName}\n镜像: ${fullImage}` }
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
      project: { type: 'string', description: '模块名称' },
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
          const composeFile = resolveComposeFile(composePath)
          command = `COMPOSE_CMD=$(docker compose version >/dev/null 2>&1 && echo "docker compose" || echo "docker-compose") && $COMPOSE_CMD -f '${composeFile}' restart ${containerName}`
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
