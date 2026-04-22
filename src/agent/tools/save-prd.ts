import { registerTool } from './index.js'
import type { AgentTool, TaskContext, ToolResult } from './types.js'
import {
  createPrdDocument,
  getPrdDocumentById,
  updatePrdContent,
} from '../../db/repositories/prd-documents.js'

/**
 * 保存 PRD：
 * - 未传 prdId → 创建（version = 1, status = 'drafting'）
 * - 传 prdId   → 更新并 version++
 *
 * 调用方（Claude）应在生成完整 Markdown 后调用一次，
 * 随后 postRunHook 触发自审。
 */
const savePrdTool: AgentTool = {
  name: 'save_prd',
  description:
    '保存/更新 PRD Markdown 文档。首次保存请省略 prdId；更新已有 PRD 请传 prdId。保存后系统会自动触发自审。',
  riskLevel: 'low',
  inputSchema: {
    type: 'object',
    properties: {
      prdId: { type: 'number', description: '已有 PRD 的 ID（更新模式）；首次创建请省略' },
      title: { type: 'string', description: 'PRD 标题，例如「用户管理模块 PRD」' },
      contentMarkdown: { type: 'string', description: '完整的 PRD Markdown 内容（9 章节模板）' },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: '可选的标签（如 ["用户管理","二期"]）',
      },
    },
    required: ['title', 'contentMarkdown'],
  },

  async execute(params: unknown, ctx: TaskContext): Promise<ToolResult> {
    const raw = (params ?? {}) as Record<string, unknown>
    const prdId = typeof raw.prdId === 'number' ? raw.prdId : undefined
    const contentMarkdown =
      (typeof raw.contentMarkdown === 'string' && raw.contentMarkdown) ||
      (typeof raw.content === 'string' && raw.content) ||
      (typeof raw.markdown === 'string' && raw.markdown) ||
      ''
    let title = typeof raw.title === 'string' ? raw.title.trim() : ''
    if (!title && contentMarkdown) {
      const h1 = contentMarkdown.match(/^#\s+(.+?)\s*$/m)
      if (h1) title = h1[1].trim()
    }
    const tags = Array.isArray(raw.tags) ? (raw.tags as string[]) : undefined

    if (!contentMarkdown) {
      return {
        success: false,
        output:
          '缺少 PRD 正文。请用参数名 `contentMarkdown` 传入完整 Markdown（或 `content`/`markdown` 作为兼容别名）。',
      }
    }
    if (!title) {
      return {
        success: false,
        output:
          '缺少 PRD 标题。请显式传入 `title`，或在 Markdown 首行写 `# 标题`（会自动提取）。',
      }
    }

    const productLineId = ctx.productLineId
    if (!productLineId && !prdId) {
      return {
        success: false,
        output: '当前用户未绑定产品线，无法创建 PRD。请联系管理员。',
      }
    }

    try {
      if (prdId) {
        const existing = await getPrdDocumentById(prdId)
        if (!existing) {
          return { success: false, output: `PRD #${prdId} 不存在` }
        }
        const updated = await updatePrdContent(prdId, {
          title,
          contentMarkdown,
          tags,
          agentSessionId: ctx.taskId,
        })
        if (!updated) {
          return { success: false, output: `PRD #${prdId} 更新失败` }
        }
        return {
          success: true,
          output: `✅ PRD #${updated.id} 已更新（v${updated.version}）。系统将触发自审。`,
          data: { prdId: updated.id, version: updated.version, status: updated.status },
        }
      }

      const created = await createPrdDocument({
        productLineId: productLineId!,
        title,
        contentMarkdown,
        createdBy: ctx.initiatorId,
        groupId: ctx.groupId,
        platform: ctx.platform,
        agentSessionId: ctx.taskId,
        tags,
      })
      return {
        success: true,
        output: `✅ PRD #${created.id}「${created.title}」已创建（v${created.version}）。系统将触发自审。`,
        data: { prdId: created.id, version: created.version, status: created.status },
      }
    } catch (err) {
      return {
        success: false,
        output: `保存 PRD 失败：${err instanceof Error ? err.message : String(err)}`,
      }
    }
  },
}

registerTool(savePrdTool)
export { savePrdTool }
