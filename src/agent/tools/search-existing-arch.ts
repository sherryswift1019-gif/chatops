import { registerTool } from './index.js'
import type { AgentTool, TaskContext, ToolResult } from './types.js'
import { searchArchDocuments } from '../../db/repositories/arch-documents.js'

const searchExistingArchTool: AgentTool = {
  name: 'search_existing_arch',
  description:
    '按关键词搜索已有架构设计文档。用于 Phase 1 确认是否已有相关架构文档，避免重复设计。' +
    '找到相关文档时，告知用户并询问是否需要对齐或复用。',
  riskLevel: 'low',
  inputSchema: {
    type: 'object',
    properties: {
      keyword: {
        type: 'string',
        description: '搜索关键词（模块名、技术关键词等）',
      },
      productLineId: {
        type: 'number',
        description: '产品线 ID（可选，不传则全局搜索）',
      },
    },
    required: ['keyword'],
  },

  async execute(params: unknown, ctx: TaskContext): Promise<ToolResult> {
    const raw = (params ?? {}) as Record<string, unknown>
    const keyword = typeof raw.keyword === 'string' ? raw.keyword.trim() : ''
    if (!keyword) {
      return { success: false, output: 'keyword 为必填参数' }
    }

    const productLineId =
      typeof raw.productLineId === 'number'
        ? raw.productLineId
        : ctx.productLineId ?? undefined

    const docs = await searchArchDocuments({ productLineId, keyword, limit: 5 })

    if (docs.length === 0) {
      return {
        success: true,
        output: `未找到与「${keyword}」相关的已有架构文档。`,
        data: { count: 0, items: [] },
      }
    }

    const list = docs
      .map(d => `- #${d.id} 《${d.title}》（状态: ${d.status}，更新: ${d.updatedAt.toISOString().slice(0, 10)}）`)
      .join('\n')

    return {
      success: true,
      output: `找到 ${docs.length} 份相关架构文档：\n${list}\n\n请告知用户并询问是否需要对齐或复用。`,
      data: {
        count: docs.length,
        items: docs.map(d => ({ archId: d.id, title: d.title, status: d.status, sourcePrdId: d.sourcePrdId })),
      },
    }
  },
}

registerTool(searchExistingArchTool)
