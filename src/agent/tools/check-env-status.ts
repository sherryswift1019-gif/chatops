import { registerTool } from './index.js'
import { listProjects } from '../../db/repositories/projects-repo.js'
import { getProductLineById } from '../../db/repositories/product-lines.js'
import { listEnvironments } from '../../db/repositories/environments-repo.js'
import { listProductLineEnvs } from '../../db/repositories/product-line-envs.js'
import { getRecentDeployments } from '../../db/repositories/deployments.js'
import { getConfig } from '../../db/repositories/system-config.js'
import { getTestServerById } from '../../db/repositories/test-servers.js'
import { probeContainer } from './env-status/docker-probe.js'
import { probeK8sDeployment } from './env-status/k8s-probe.js'
import { getLatestBranchCommit, compareCommits } from './env-status/gitlab.js'
import { resolveProjectStatus } from './env-status/resolver.js'
import { formatEnvStatusOutput, type ProjectRow } from './env-status/formatter.js'
import { findDeployedTag } from './env-status/tag-parser.js'
import type { AgentTool, TaskContext, ToolResult } from './types.js'
import type { SSHTarget } from './ssh-utils.js'
import { appendFileSync } from 'fs'
import { resolveComposeFile, findProjectByName, findEnvByName } from './ssh-utils.js'

function log(msg: string) {
  try { appendFileSync('/tmp/mcp-server.log', `[${new Date().toISOString()}] [env-status] ${msg}\n`) } catch { /* */ }
}

async function resolveServers(serverIds: number[]): Promise<SSHTarget[]> {
  const all = await Promise.all(serverIds.map(id => getTestServerById(id)))
  return all
    .filter((s): s is NonNullable<typeof s> => s !== null)
    .map(s => ({ host: s.host, port: s.port, username: s.username, password: s.credential }))
}

function registryHostFrom(harborUrl: string): string {
  return harborUrl.replace(/^https?:\/\//, '').replace(/\/$/, '')
}

interface ScanArgs {
  ctx: TaskContext
  plEnv: Awaited<ReturnType<typeof listProductLineEnvs>>[number]
  plDisplay: string
  envName: string
  projectName?: string
}

async function scanK8sEnvironment(args: ScanArgs): Promise<ToolResult> {
  const { ctx, plEnv, plDisplay, envName, projectName } = args

  const cfg = plEnv.connectionConfig as { serverIds?: number[] }
  const servers = await resolveServers(Array.isArray(cfg.serverIds) ? cfg.serverIds : [])
  if (servers.length === 0) {
    return { success: false, output: `环境 "${envName}" 未配置服务器，请在产线环境配置中补充。` }
  }

  const harborCfg = await getConfig('harbor')
  const harborUrl = (harborCfg?.value as Record<string, string> | undefined)?.url ?? ''
  const registryHost = registryHostFrom(harborUrl)

  const allProjects = await listProjects(ctx.productLineId!)
  const scoped = (() => {
    if (!projectName) return allProjects
    const matched = findProjectByName(allProjects, projectName)
    return matched ? [matched] : []
  })()

  if (scoped.length === 0) {
    return { success: false, output: projectName ? `模块 "${projectName}" 不在产线下。` : '当前产线下还没有模块。' }
  }

  // kubectl is expected to be configured on servers[0]
  const targetServer = servers[0]
  const namespace = plEnv.namespace || envName

  const rows: ProjectRow[] = await Promise.all(scoped.map(async (project): Promise<ProjectRow> => {
    const deploymentName = project.k8sProjectName || project.name
    const harborProject = project.harborProject || project.name

    try {
      const k8s = await probeK8sDeployment(targetServer, deploymentName, namespace)

      // Determine status
      let status: ProjectRow['resolved']['status']
      let errorMsg: string | undefined

      if (k8s.error === 'not found' || (k8s.ready === 0 && k8s.replicas === 0 && !k8s.error)) {
        status = 'not_deployed'
      } else if (k8s.error) {
        status = 'down'
        errorMsg = k8s.error
      } else if (k8s.ready === k8s.replicas && k8s.replicas > 0) {
        status = 'healthy'
      } else if (k8s.ready > 0 && k8s.ready < k8s.replicas) {
        status = 'degraded'
      } else {
        // ready === 0 && replicas > 0
        status = 'down'
      }

      // Attempt to parse the image tag for the deployed field
      let deployed: ProjectRow['resolved']['deployed'] = null
      if (k8s.image) {
        // Try to find image tag using registry host prefix
        const prefix = `${registryHost}/${harborProject}:`
        if (k8s.image.startsWith(prefix)) {
          const tag = k8s.image.slice(prefix.length)
          deployed = findDeployedTag([k8s.image], registryHost, harborProject)
          if (!deployed) {
            // Keep raw tag as a fallback with minimal DeployedTag structure
            deployed = { branch: '', shortId: '', imageTag: tag }
          }
        }
      }

      // Container state mapping
      const containerState: 'running' | 'exited' =
        status === 'healthy' || status === 'degraded' ? 'running' : 'exited'

      return {
        name: project.name,
        displayName: project.displayName || project.name,
        resolved: {
          status,
          deployed,
          latest: null,
          commitsBehind: null,
        },
        container: {
          name: deploymentName,
          state: containerState,
          startedAt: '',
        },
        servers: servers.map(s => s.host),
        error: errorMsg,
      }
    } catch (err) {
      log(`k8s project ${project.name} error: ${String(err)}`)
      return {
        name: project.name,
        displayName: project.displayName || project.name,
        resolved: { status: 'unknown', deployed: null, latest: null, commitsBehind: null },
        container: { name: deploymentName },
        servers: servers.map(s => s.host),
        error: String(err),
      }
    }
  }))

  const output = formatEnvStatusOutput({
    env: envName,
    productLine: plDisplay,
    defaultBranch: plEnv.defaultBranch,
    projects: rows,
  })

  const footer = '\n注：K8s 环境仅显示基础状态，commit 对比待后续支持。'

  return {
    success: true,
    output: output + footer,
    data: {
      env: envName,
      productLine: plDisplay,
      defaultBranch: plEnv.defaultBranch,
      runtime: 'kubernetes',
      note: 'k8s_basic',
      servers: servers.map(s => ({ host: s.host, port: s.port })),
      projects: rows.map(r => ({
        name: r.name,
        status: r.resolved.status,
        container: r.container,
        deployed: r.resolved.deployed,
        latest: r.resolved.latest,
        commitsBehind: r.resolved.commitsBehind,
        error: r.error,
      })),
    },
  }
}

export const checkEnvStatusTool: AgentTool = {
  name: 'check_environment_status',
  description: '检查指定环境下所有模块（或单个模块）的实时部署状态：容器运行情况、启动时长、当前部署 commit 与 GitLab 最新 commit 的差距。',
  riskLevel: 'low',
  inputSchema: {
    type: 'object',
    properties: {
      env: { type: 'string', description: '环境名，如 dev/staging/prod' },
      project: { type: 'string', description: '可选，单模块查询' },
    },
    required: ['env'],
  },
  async execute(params: unknown, ctx: TaskContext): Promise<ToolResult> {
    const { env: envName, project: projectName } = params as { env: string; project?: string }
    log(`execute: env=${envName} project=${projectName ?? '*'} pl=${ctx.productLineId}`)

    if (!ctx.productLineId) {
      return { success: false, output: '⛔ 你未加入任何产线，无法查询环境状态。' }
    }

    const envs = await listEnvironments()
    const envRow = findEnvByName(envs, envName)
    if (!envRow) return { success: false, output: `环境 "${envName}" 未定义。` }

    const plEnvs = await listProductLineEnvs(ctx.productLineId)
    const plEnv = plEnvs.find(p => p.envId === envRow.id)
    const pl = await getProductLineById(ctx.productLineId)
    const plDisplay = pl?.displayName ?? pl?.name ?? `PL#${ctx.productLineId}`
    if (!plEnv) return { success: false, output: `产线 "${plDisplay}" 未配置 "${envName}" 环境。` }

    if (plEnv.runtime === 'kubernetes') {
      return await scanK8sEnvironment({ ctx, plEnv, plDisplay, envName, projectName })
    }

    if (plEnv.runtime !== 'docker') {
      return { success: true, output: `环境 "${envName}" 运行时为 ${plEnv.runtime}。详细状态查询暂不支持。` }
    }

    const cfg = plEnv.connectionConfig as { serverIds?: number[] }
    const servers = await resolveServers(Array.isArray(cfg.serverIds) ? cfg.serverIds : [])
    if (servers.length === 0) {
      return { success: false, output: `环境 "${envName}" 未配置服务器，请在产线环境配置中补充。` }
    }

    const harborCfg = await getConfig('harbor')
    const harborUrl = (harborCfg?.value as Record<string, string> | undefined)?.url ?? ''
    const registryHost = registryHostFrom(harborUrl)

    const allProjects = await listProjects(ctx.productLineId)
    const scoped = (() => {
      if (!projectName) return allProjects
      const matched = findProjectByName(allProjects, projectName)
      return matched ? [matched] : []
    })()

    if (scoped.length === 0) {
      return { success: false, output: projectName ? `模块 "${projectName}" 不在产线下。` : '当前产线下还没有模块。' }
    }

    // Each project may produce 1 row (consensus) or N rows (diverged — one per server)
    const rowArrays: ProjectRow[][] = await Promise.all(scoped.map(async (project): Promise<ProjectRow[]> => {
      const composeFile = project.composePath ? resolveComposeFile(project.composePath) : undefined
      // In compose mode, dockerContainerName is the compose service name; in bare-docker mode,
      // it's the actual container name.
      const serviceName = project.dockerContainerName || project.name
      const harborProject = project.harborProject || project.name

      try {
        const probePromises = servers.map(s => probeContainer(s, composeFile, serviceName, registryHost, harborProject))
        const branchForGitLab = plEnv.defaultBranch
        const latestPromise = branchForGitLab && project.gitlabPath
          ? getLatestBranchCommit(project.gitlabPath, branchForGitLab)
          : Promise.resolve(null)
        const historyPromise = getRecentDeployments(project.name, envName, 1)

        const [probeResults, latest, history] = await Promise.all([
          Promise.all(probePromises),
          latestPromise,
          historyPromise,
        ])

        // Divergence detection: probes agree if they share same state and same deployed shortId
        const sig = (p: (typeof probeResults)[number]) =>
          `${p.container.exists ? p.container.state : 'missing'}|${p.deployed?.shortId ?? 'none'}`
        const uniqSignatures = new Set(probeResults.map(sig))
        const diverged = probeResults.length > 1 && uniqSignatures.size > 1

        if (!diverged) {
          // Single-row (consensus) path
          const probe = probeResults.find(p => p.container.exists) ?? probeResults[0]

          let compare: Awaited<ReturnType<typeof compareCommits>> | null = null
          if (probe.deployed && latest && probe.deployed.shortId !== latest.shortId && project.gitlabPath) {
            compare = await compareCommits(project.gitlabPath, probe.deployed.shortId, latest.shortId)
          }

          const resolved = resolveProjectStatus({ probe, latest, compare, hasHistory: history.length > 0 })
          return [{
            name: project.name,
            displayName: project.displayName || project.name,
            resolved,
            container: {
              name: probe.container.actualName,
              state: probe.container.state,
              startedAt: probe.container.startedAt,
              health: probe.container.health,
              exitCode: probe.container.exitCode,
              serviceName: composeFile ? serviceName : undefined,
              actualName: probe.container.actualName,
              composeFile,
            },
            servers: servers.map(s => s.host),
            error: probe.error,
          }]
        }

        // Diverged path: one row per server — skip compareCommits
        return probeResults.map((probe, i) => {
          const resolved = resolveProjectStatus({ probe, latest, compare: null, hasHistory: history.length > 0 })
          return {
            name: project.name,
            displayName: `${project.displayName || project.name} @ ${servers[i].host}`,
            resolved,
            container: {
              name: probe.container.actualName,
              state: probe.container.state,
              startedAt: probe.container.startedAt,
              health: probe.container.health,
              exitCode: probe.container.exitCode,
              serviceName: composeFile ? serviceName : undefined,
              actualName: probe.container.actualName,
              composeFile,
            },
            servers: [servers[i].host],
            error: probe.error,
          }
        })
      } catch (err) {
        log(`project ${project.name} error: ${String(err)}`)
        return [{
          name: project.name,
          displayName: project.displayName || project.name,
          resolved: { status: 'unknown', deployed: null, latest: null, commitsBehind: null },
          container: { serviceName: composeFile ? serviceName : undefined, composeFile },
          servers: servers.map(s => s.host),
          error: String(err),
        }]
      }
    }))

    const rows = rowArrays.flat()

    const output = formatEnvStatusOutput({
      env: envName,
      productLine: plDisplay,
      defaultBranch: plEnv.defaultBranch,
      projects: rows,
    })

    return {
      success: true,
      output,
      data: {
        env: envName,
        productLine: plDisplay,
        defaultBranch: plEnv.defaultBranch,
        servers: servers.map(s => ({ host: s.host, port: s.port })),
        projects: rows.map(r => ({
          name: r.name,
          status: r.resolved.status,
          container: r.container,
          deployed: r.resolved.deployed,
          latest: r.resolved.latest,
          commitsBehind: r.resolved.commitsBehind,
          commitsBehindNote: r.resolved.commitsBehindNote,
          latestCommitSummaries: r.resolved.latestCommitSummaries,
          error: r.error,
        })),
      },
    }
  },
}

registerTool(checkEnvStatusTool)
