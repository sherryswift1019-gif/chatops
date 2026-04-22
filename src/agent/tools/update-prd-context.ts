import { registerTool } from './index.js'
import type { AgentTool, TaskContext, ToolResult } from './types.js'
import {
  getPrdDocumentById,
  createPrdDocument,
} from '../../db/repositories/prd-documents.js'
import { getPool } from '../../db/client.js'

/**
 * 更新 PRD 工作流元数据（content_json）。
 *
 * content_markdown 是"给人/下游 Agent 读的 PRD 正文"，
 * content_json 用来存 Agent 内部的工作流状态：
 *   { phase: 'discovery'|'functional'|'scope_confirmation'|'generated',
 *     dialogueRounds: 5,
 *     contextSummary: "...",
 *     pendingQuestions: [...] }
 *
 * Agent 在对话过程中调用此工具，记录当前所处阶段和累积的上下文摘要，
 * 方便 session 过期后其他 Agent 恢复上下文。
 */
const updatePrdContextTool: AgentTool = {
  name: 'update_prd_context',
  description:
    '更新 PRD 的工作流元数据（内部状态：当前阶段、对话摘要、待确认问题等）。仅在首次创建 PRD 前对话阶段使用——已存在 PRD 请走 save_prd。',
  riskLevel: 'low',
  inputSchema: {
    type: 'object',
    properties: {
      prdId: { type: 'number', description: '已创建的 PRD ID（未创建则省略）' },
      title: { type: 'string', description: 'PRD 暂定标题（首次调用时传入）' },
      contextJson: {
        type: 'object',
        description: '工作流元数据，推荐字段：phase, dialogueRounds, contextSummary, pendingQuestions',
      },
    },
    required: ['contextJson'],
  },

  async execute(params: unknown, ctx: TaskContext): Promise<ToolResult> {
    const { prdId, title, contextJson } = params as {
      prdId?: number
      title?: string
      contextJson: Record<string, unknown>
    }

    try {
      if (prdId) {
        const existing = await getPrdDocumentById(prdId)
        if (!existing) {
          return { success: false, output: `PRD #${prdId} 不存在` }
        }
        const pool = getPool()
        const { rows } = await pool.query(
          `UPDATE prd_documents
             SET content_json = $2::jsonb, updated_at = NOW()
           WHERE id = $1 RETURNING id, content_json`,
          [prdId, JSON.stringify(contextJson)]
        )
        return {
          success: true,
          output: `✅ PRD #${prdId} 的工作流上下文已更新。`,
          data: { prdId, contextJson: rows[0]?.content_json },
        }
      }

      const productLineId = ctx.productLineId
      if (!productLineId) {
        return {
          success: false,
          output: '当前用户未绑定产品线，无法创建 PRD 草稿上下文。',
        }
      }

      const draft = await createPrdDocument({
        productLineId,
        title: title ?? '（草稿）',
        contentMarkdown: '',
        contentJson: contextJson,
        createdBy: ctx.initiatorId,
        groupId: ctx.groupId,
        platform: ctx.platform,
        agentSessionId: ctx.taskId,
      })
      return {
        success: true,
        output: `✅ 已创建 PRD 草稿 #${draft.id}，工作流上下文已记录。`,
        data: { prdId: draft.id, contextJson: draft.contentJson },
      }
    } catch (err) {
      return {
        success: false,
        output: `更新 PRD 上下文失败：${err instanceof Error ? err.message : String(err)}`,
      }
    }
  },
}

registerTool(updatePrdContextTool)
export { updatePrdContextTool }
