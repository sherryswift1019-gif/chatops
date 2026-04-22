import { registerTool } from './index.js'
import type { AgentTool, TaskContext, ToolResult } from './types.js'
import { searchPrdDocuments } from '../../db/repositories/prd-documents.js'

/**
 * 搜索已有 PRD。主要用于 Phase 1（项目发现）阶段，
 * 让 Agent 能检索同产品线下的历史 PRD，避免重复创建或遗漏关联。
 */
const searchExistingPrdsTool: AgentTool = {
  name: 'search_existing_prds',
  description:
    '按关键词搜索当前产品线下已有的 PRD（模糊匹配标题和内容）。返回摘要列表，用于检索历史 PRD 作为参考或避免重复。',
  riskLevel: 'low',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '关键词（例如"用户管理"、"权限"）' },
      limit: { type: 'number', description: '最多返回条数，默认 10' },
    },
    required: ['query'],
  },

  async execute(params: unknown, ctx: TaskContext): Promise<ToolResult> {
    const { query, limit } = params as { query: string; limit?: number }
    const productLineId = ctx.productLineId
    if (!productLineId) {
      return { success: true, output: '当前用户未绑定产品线，无结果。', data: { results: [] } }
    }

    try {
      const results = await searchPrdDocuments(query, {
        productLineId,
        limit: limit ?? 10,
      })

      if (results.length === 0) {
        return {
          success: true,
          output: `未找到匹配「${query}」的已有 PRD。`,
          data: { results: [] },
        }
      }

      const lines = results.map(
        (p) =>
          `- PRD #${p.id}「${p.title}」(v${p.version}, ${p.status}) · ${p.updatedAt.toISOString?.().split('T')[0] ?? p.updatedAt}`
      )
      const output = `找到 ${results.length} 条相关 PRD：\n${lines.join('\n')}`

      return {
        success: true,
        output,
        data: {
          results: results.map((p) => ({
            id: p.id,
            title: p.title,
            version: p.version,
            status: p.status,
            tags: p.tags,
            updatedAt: p.updatedAt,
          })),
        },
      }
    } catch (err) {
      return {
        success: false,
        output: `搜索 PRD 失败：${err instanceof Error ? err.message : String(err)}`,
      }
    }
  },
}

registerTool(searchExistingPrdsTool)
export { searchExistingPrdsTool }
