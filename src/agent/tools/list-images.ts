import { registerTool } from './index.js'
import { getFreshImages, upsertImageCache } from '../../db/repositories/image-cache.js'
import { getConfig } from '../../db/repositories/system-config.js'
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

    // Try cache first
    const cached = await getFreshImages(project, limit)
    if (cached.length > 0) {
      return formatImages(project, cached)
    }

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

      const res = await axios.get(
        `${harbor.url}/api/v2.0/projects/${project}/repositories/${encodeURIComponent(project)}/artifacts`,
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
          project,
          tag,
          digest: artifact.digest,
          builtAt: new Date(artifact.push_time),
          commitSha: artifact.extra_attrs?.config?.Labels?.['commit'] ?? undefined,
          commitMessage: artifact.extra_attrs?.config?.Labels?.['commit_message'] ?? undefined,
        })
      }

      const fresh = await getFreshImages(project, limit)
      return formatImages(project, fresh)
    } catch (err) {
      return { success: false, output: `Harbor 访问失败: ${String(err)}` }
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
