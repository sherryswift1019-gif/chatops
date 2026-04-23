import { registerTool } from './index.js'
import type { AgentTool, TaskContext, ToolResult } from './types.js'
import { getPrdDocumentById } from '../../db/repositories/prd-documents.js'
import type { StructuredPrd } from '../prd/structured-types.js'

/**
 * 读取 PRD 的完整内容。
 * 主要使用场景：
 * 1. 交付后修改（session 已过期，需要重载上下文）
 * 2. 自审 Agent（审查目标文档）
 *
 * V2：额外暴露 structuredPrd / rulesVersion，供 Agent 判断走 V1 或 V2 修改路径。
 */
const readPrdTool: AgentTool = {
  name: 'read_prd',
  description:
    '读取指定 PRD 的完整 Markdown 内容、元信息、自审结果、以及 V2 结构化数据（若为 V2 PRD）。用于：1) 交付后修改时重载上下文；2) 系统内部自审调用。',
  riskLevel: 'low',
  inputSchema: {
    type: 'object',
    properties: {
      prdId: { type: 'number', description: 'PRD 的 ID' },
    },
    required: ['prdId'],
  },

  async execute(params: unknown, _ctx: TaskContext): Promise<ToolResult> {
    const { prdId } = params as { prdId: number }

    try {
      const prd = await getPrdDocumentById(prdId)
      if (!prd) {
        return { success: false, output: `PRD #${prdId} 不存在` }
      }

      const cj = (prd.contentJson ?? {}) as Record<string, unknown>
      const structuredPrd =
        cj.structuredPrd && typeof cj.structuredPrd === 'object'
          ? (cj.structuredPrd as StructuredPrd)
          : null
      const rulesVersion =
        typeof cj.rulesVersion === 'string' ? cj.rulesVersion : null
      const prdVersionTag = structuredPrd
        ? `V2${rulesVersion ? ` (${rulesVersion})` : ''}`
        : 'V1'

      const header = [
        `# PRD #${prd.id}「${prd.title}」`,
        `- 版本: v${prd.version}`,
        `- 状态: ${prd.status}`,
        `- 创建者: ${prd.createdBy}`,
        `- 产品线: ${prd.productLineId}`,
        `- 标签: ${prd.tags.length ? prd.tags.join(', ') : '（无）'}`,
        `- 更新时间: ${prd.updatedAt.toISOString?.() ?? prd.updatedAt}`,
        `- PRD 版本标识: ${prdVersionTag}`,
      ].join('\n')

      const reviewSection = prd.reviewResult
        ? `\n\n## 最近一次自审结果\n\n\`\`\`json\n${JSON.stringify(prd.reviewResult, null, 2)}\n\`\`\``
        : ''

      const output = `${header}\n\n---\n\n${prd.contentMarkdown}${reviewSection}`

      return {
        success: true,
        output,
        data: {
          prdId: prd.id,
          version: prd.version,
          status: prd.status,
          title: prd.title,
          contentMarkdown: prd.contentMarkdown,
          contentJson: prd.contentJson,
          structuredPrd,
          rulesVersion,
          reviewResult: prd.reviewResult,
          tags: prd.tags,
        },
      }
    } catch (err) {
      return {
        success: false,
        output: `读取 PRD 失败：${err instanceof Error ? err.message : String(err)}`,
      }
    }
  },
}

registerTool(readPrdTool)
export { readPrdTool }
