import { registerTool } from './index.js'
import { listProjects } from '../../db/repositories/projects-repo.js'
import { listProductLines } from '../../db/repositories/product-lines.js'
import type { AgentTool, TaskContext, ToolResult } from './types.js'

function renderModule(p: {
  name: string; displayName: string; ownerName: string;
  gitlabPath: string; harborProject: string
}): string {
  const parts: string[] = []
  parts.push(`👤 ${p.ownerName || '未指定负责人'}`)
  if (p.gitlabPath) parts.push(`GitLab: \`${p.gitlabPath}\``)
  if (p.harborProject) parts.push(`Harbor: \`${p.harborProject}\``)
  return `**${p.displayName}** (\`${p.name}\`)\n${parts.join(' · ')}`
}

export const listProductLineProjectsTool: AgentTool = {
  name: 'list_product_line_projects',
  description: 'List all business modules (projects) under the user\'s current product line, including owner name, GitLab path, and Harbor project.',
  riskLevel: 'low',
  inputSchema: { type: 'object', properties: {} },
  async execute(_params: unknown, ctx: TaskContext): Promise<ToolResult> {
    const productLineId = (ctx as unknown as { productLineId?: number }).productLineId
    if (!productLineId) {
      return { success: true, output: '你还没绑定产线，请联系管理员添加你到产线。' }
    }

    const [allLines, projects] = await Promise.all([
      listProductLines(),
      listProjects(productLineId),
    ])
    const line = allLines.find(l => l.id === productLineId)
    const lineName = line?.displayName ?? `产线 #${productLineId}`

    if (projects.length === 0) {
      return { success: true, output: `当前产线「${lineName}」下还没有配置模块。` }
    }

    const header = `## ${lineName} · ${projects.length} 个模块`
    const body = projects.map(renderModule).join('\n\n')
    return { success: true, output: `${header}\n\n${body}`, data: projects }
  },
}

registerTool(listProductLineProjectsTool)
