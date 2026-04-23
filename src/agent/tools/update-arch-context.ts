import { registerTool } from './index.js'
import type { AgentTool, TaskContext, ToolResult } from './types.js'
import {
  createArchDocument,
  getArchDocumentById,
  updateArchDocument,
} from '../../db/repositories/arch-documents.js'

/**
 * update_arch_context — 持久化架构设计对话上下文
 *
 * 每轮对话结束时调用（第二轮起），将当前阶段摘要写入
 * arch_documents.content_json，以便 session 过期后恢复上下文。
 *
 * 首次调用 archId 传 null，系统会创建 drafting 骨架并返回 archId。
 * 后续调用使用返回的 archId。
 */
const updateArchContextTool: AgentTool = {
  name: 'update_arch_context',
  description:
    '持久化架构设计对话上下文。每轮对话结束时调用（第二轮起）。' +
    '首次调用 archId 传 null，系统自动创建 drafting 骨架并返回 archId；' +
    '后续调用使用返回的 archId。',
  riskLevel: 'low',
  inputSchema: {
    type: 'object',
    properties: {
      archId: {
        type: ['number', 'null'],
        description: '已有架构文档 ID；首次调用传 null',
      },
      phase: {
        type: 'string',
        description: '当前对话阶段：phase1 / phase2 / phase3 / phase4 / phase5',
      },
      dialogueRounds: {
        type: 'number',
        description: '已对话轮次',
      },
      contextSummary: {
        type: 'string',
        description: '精炼的上下文摘要（关键事实 + 用户偏好 + 已确认/待定事项），100-300 字',
      },
      pendingQuestions: {
        type: 'array',
        items: { type: 'string' },
        description: '待用户确认的问题列表',
      },
      sourcePrdId: {
        type: 'number',
        description: '关联的 PRD ID（可选，首次调用时传入）',
      },
    },
    required: ['phase', 'contextSummary'],
  },

  async execute(params: unknown, ctx: TaskContext): Promise<ToolResult> {
    const raw = (params ?? {}) as Record<string, unknown>
    const archId = typeof raw.archId === 'number' ? raw.archId : null
    const phase = typeof raw.phase === 'string' ? raw.phase : 'phase1'
    const dialogueRounds = typeof raw.dialogueRounds === 'number' ? raw.dialogueRounds : 0
    const contextSummary = typeof raw.contextSummary === 'string' ? raw.contextSummary : ''
    const pendingQuestions = Array.isArray(raw.pendingQuestions) ? raw.pendingQuestions as string[] : []
    const sourcePrdId = typeof raw.sourcePrdId === 'number' ? raw.sourcePrdId : null

    const contextPatch = { phase, dialogueRounds, contextSummary, pendingQuestions }

    if (archId) {
      const doc = await getArchDocumentById(archId)
      if (!doc) return { success: false, output: `找不到架构文档 #${archId}` }

      const newJson = { ...(doc.contentJson as Record<string, unknown>), ...contextPatch }
      await updateArchDocument(archId, { contentJson: newJson })

      return {
        success: true,
        output: `架构文档 #${archId} 上下文已更新（${phase}）`,
        data: { archId },
      }
    }

    // 首次：创建 drafting 骨架
    const doc = await createArchDocument({
      productLineId: ctx.productLineId ?? 0,
      sourcePrdId,
      title: '架构设计文档（草稿）',
      contentMarkdown: '',
      contentJson: contextPatch,
      createdBy: ctx.initiatorId,
      agentSessionId: ctx.taskId,
    })

    return {
      success: true,
      output: `已创建架构文档草稿（ID: ${doc.id}），上下文已保存（${phase}）`,
      data: { archId: doc.id },
    }
  },
}

registerTool(updateArchContextTool)
