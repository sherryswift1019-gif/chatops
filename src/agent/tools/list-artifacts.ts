import { registerTool } from './index.js'
import { listArtifacts } from '../../pipeline/artifact-resolver.js'
import type { AgentTool, TaskContext, ToolResult } from './types.js'

const MAX = 10

function fmtSize(bytes: number): string {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(1)} GB`
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`
  if (bytes >= 1 << 10) return `${(bytes / (1 << 10)).toFixed(1)} KB`
  return `${bytes} B`
}

function fmtTime(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16)
}

export const listArtifactsTool: AgentTool = {
  name: 'list_artifacts',
  description: '列出制品仓库中符合 glob 的文件（按修改时间倒序，最多 10 条）。触发流水线前让用户选包时使用。',
  riskLevel: 'low',
  inputSchema: {
    type: 'object',
    properties: {
      listUrl: { type: 'string', description: '目录列表 URL，如 http://repo/path（不带 ?json=true）' },
      glob: { type: 'string', description: '可选过滤模式，如 PAM-Docker-*.tar.gz' },
      authHeaders: { type: 'object', description: '可选鉴权头', additionalProperties: { type: 'string' } },
    },
    required: ['listUrl'],
  },

  async execute(params: unknown, _ctx: TaskContext): Promise<ToolResult> {
    const p = (params ?? {}) as { listUrl?: string; glob?: string; authHeaders?: Record<string, string> }
    if (!p.listUrl) return { success: false, output: '缺少必要参数 listUrl' }

    try {
      const all = await listArtifacts({ listUrl: p.listUrl, glob: p.glob ?? '', authHeaders: p.authHeaders })
      if (all.length === 0) {
        return { success: true, output: `没有匹配 \`${p.glob ?? '*'}\` 的文件。请核对 glob 或仓库路径。` }
      }
      const head = all.slice(0, MAX)
      const truncated = all.length > MAX
      const lines = head.map((f, i) => `${i + 1}. \`${f.name}\`  ${fmtSize(f.size)}  ${fmtTime(f.mtime)}`)
      const tip = truncated ? `\n\n> 还有 ${all.length - MAX} 个未显示，如需更多请说明。` : ''
      return {
        success: true,
        output: `找到 ${all.length} 个文件，请回复编号或文件名：\n\n${lines.join('\n')}${tip}`,
        data: { files: head, truncated, total: all.length },
      }
    } catch (e) {
      return { success: false, output: (e as Error).message }
    }
  },
}

registerTool(listArtifactsTool)
