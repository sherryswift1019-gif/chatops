import { registerTool } from './index.js'
import { getFreshImages, upsertImageCache } from '../../db/repositories/image-cache.js'
import { getConfig } from '../../db/repositories/system-config.js'
import { listProjects } from '../../db/repositories/projects-repo.js'
import axios from 'axios'
import https from 'https'
import type { AgentTool, TaskContext, ToolResult } from './types.js'

async function getHarborConfig(): Promise<{ url: string; username: string; password: string; skipTlsVerify: boolean; caCert?: string }> {
  const cfg = await getConfig('harbor')
  if (!cfg) {
    // Fallback to env vars
    return {
      url: process.env.HARBOR_URL ?? '',
      username: process.env.HARBOR_USERNAME ?? '',
      password: process.env.HARBOR_PASSWORD ?? '',
      skipTlsVerify: false,
    }
  }
  const v = cfg.value as Record<string, string>
  return {
    url: v.url ?? '',
    username: v.username ?? '',
    password: v.password ?? '',
    skipTlsVerify: v.skipTlsVerify === 'true' || v.skipTlsVerify === true as unknown as string,
    caCert: v.caCert,
  }
}

const listImagesTool: AgentTool = {
  name: 'list_images',
  description: 'List available images for a project from Harbor registry. Returns recent tags with commit info.',
  riskLevel: 'low',
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'Project/repository name in Harbor' },
      limit: { type: 'number', description: 'Max images to return, default 8' },
    },
    required: ['project'],
  },
  async execute(params: unknown, _ctx: TaskContext): Promise<ToolResult> {
    const { project, limit = 8 } = params as { project: string; limit?: number }

    // Lookup harborProject from projects table
    let allProjects: Awaited<ReturnType<typeof listProjects>> = []
    try {
      allProjects = await listProjects()
    } catch (err) {
      return { success: false, output: `数据库查询项目失败: ${String(err)}` }
    }
    const projectRecord = allProjects.find(p =>
      p.name === project || p.displayName === project || p.harborProject === project
    )
    const harborProject = projectRecord?.harborProject || project

    // Debug: include matching info in output if no Harbor project configured
    if (!projectRecord) {
      const projectNames = allProjects.length > 0
        ? allProjects.map(p => `${p.name}(harbor=${p.harborProject})`).join(', ')
        : '无（数据库中没有项目）'
      return { success: false, output: `项目 "${project}" 在数据库中未找到匹配。\n已注册项目: [${projectNames}]\n请确认项目名称是否正确。` }
    }
    if (!harborProject) {
      return { success: false, output: `项目 "${project}" 未配置 Harbor 镜像地址。请在管理后台的项目配置中设置 Harbor 项目路径。` }
    }

    // Try cache first
    const cached = await getFreshImages(harborProject, limit)
    if (cached.length > 0) {
      return formatImages(project, cached)
    }

    // harborProject format: "project_name/repo_name" or just "repo_name"
    const parts = harborProject.split('/')
    const harborProjectName = parts.length > 1 ? parts[0] : harborProject
    const repoName = parts.length > 1 ? parts.slice(1).join('/') : harborProject
    let apiUrl = ''

    // Fetch from Harbor
    try {
      const harbor = await getHarborConfig()
      if (!harbor.url) {
        return { success: false, output: 'Harbor URL 未配置。请在系统配置中设置 Harbor 地址。' }
      }

      const auth = Buffer.from(`${harbor.username}:${harbor.password}`).toString('base64')

      // Build HTTPS agent for self-signed certs
      const httpsAgent = new https.Agent({
        rejectUnauthorized: !harbor.skipTlsVerify,
        ...(harbor.caCert ? { ca: harbor.caCert } : {}),
      })

      apiUrl = `${harbor.url}/api/v2.0/projects/${harborProjectName}/repositories/${encodeURIComponent(repoName)}/artifacts`
      const res = await axios.get(apiUrl,
        {
          headers: { Authorization: `Basic ${auth}` },
          params: { page_size: limit, with_tag: true },
          httpsAgent,
        }
      )
      const artifacts = res.data as Array<{
        tags?: Array<{ name: string }>
        digest: string
        push_time: string
        extra_attrs?: { config?: { Labels?: Record<string, string> } }
      }>

      for (const artifact of artifacts) {
        const tag = artifact.tags?.[0]?.name ?? 'untagged'
        await upsertImageCache({
          project: harborProject,
          tag,
          digest: artifact.digest,
          builtAt: new Date(artifact.push_time),
          commitSha: artifact.extra_attrs?.config?.Labels?.['commit'] ?? undefined,
          commitMessage: artifact.extra_attrs?.config?.Labels?.['commit_message'] ?? undefined,
        })
      }

      const fresh = await getFreshImages(harborProject, limit)
      return formatImages(project, fresh)
    } catch (err) {
      const errMsg = (err as Record<string, unknown>)?.response
        ? `HTTP ${((err as Record<string, unknown>).response as Record<string, unknown>).status}: ${JSON.stringify(((err as Record<string, unknown>).response as Record<string, unknown>).data)}`
        : String(err)
      return { success: false, output: `Harbor 访问失败:\n请求: ${apiUrl}\n项目匹配: project="${project}" → harborProject="${harborProject}" (项目名=${harborProjectName}, 仓库名=${repoName})\n错误: ${errMsg}` }
    }
  },
}

function formatImages(project: string, images: Awaited<ReturnType<typeof getFreshImages>>): ToolResult {
  if (images.length === 0) return { success: true, output: `No images found for ${project}` }
  const lines = images.map((img, i) =>
    `${i + 1}. ${img.tag} | built: ${img.builtAt?.toISOString().slice(0, 10) ?? 'unknown'} | ${img.commitMessage?.slice(0, 60) ?? ''}`
  )
  return { success: true, output: `Available images for ${project}:\n${lines.join('\n')}`, data: images }
}

registerTool(listImagesTool)
export { listImagesTool }
