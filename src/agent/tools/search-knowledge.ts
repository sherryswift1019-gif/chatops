import { registerTool } from './index.js'
import type { AgentTool, TaskContext, ToolResult } from './types.js'
import { search, extractQueryFromText } from '../knowledge/index-matcher.js'
import { incrementHit } from '../../db/repositories/knowledge-hit-stats.js'

const searchKnowledgeTool: AgentTool = {
  name: 'search_knowledge',
  description: '查询产品知识库。输入问题描述，返回匹配的历史 Bug 方案或业务指南。命中时可直接使用历史方案。',
  riskLevel: 'low',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '问题描述或错误信息' },
      product: { type: 'string', description: '产品标识（如 pam、iam）' },
      version: { type: 'string', description: '版本号（可选，如 v6.7.0）' },
      modules: {
        type: 'array',
        items: { type: 'string' },
        description: '相关模块列表（可选）',
      },
    },
    required: ['query', 'product'],
  },

  async execute(params: unknown, ctx: TaskContext): Promise<ToolResult> {
    const { query, product, version, modules } = params as {
      query: string
      product: string
      version?: string
      modules?: string[]
    }

    const extracted = extractQueryFromText(query)
    const results = search(product, {
      keywords: extracted.keywords,
      errorCodes: extracted.errorCodes,
      modules: modules ?? [],
      version: version ?? '',
    })

    if (results.length === 0) {
      return { success: true, output: 'no_match', data: { hit: false } }
    }

    const top = results[0]

    // 记录命中统计（best-effort）
    try {
      const productLineId = ctx.productLineId ?? 0
      await incrementHit(top.entry.id, productLineId)
    } catch { /* best-effort */ }

    let output = `✅ 命中知识库：${top.entry.id}（匹配度: ${top.score}）\n\n`
    output += top.content
    if (results.length > 1) {
      output += `\n\n---\n还有 ${results.length - 1} 条相关结果。`
    }

    return {
      success: true,
      output,
      data: { hit: true, entryId: top.entry.id, score: top.score, totalResults: results.length },
    }
  },
}

registerTool(searchKnowledgeTool)
export { searchKnowledgeTool }
