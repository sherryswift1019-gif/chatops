import { registerTool } from './index.js'
import type { AgentTool, TaskContext, ToolResult } from './types.js'
import { getArchDocumentById } from '../../db/repositories/arch-documents.js'

const readArchTool: AgentTool = {
  name: 'read_arch',
  description:
    '读取已有架构设计文档的完整内容。传入 archId 读取指定文档；用于在对话中引用或修改现有架构文档。',
  riskLevel: 'low',
  inputSchema: {
    type: 'object',
    properties: {
      archId: { type: 'number', description: '架构文档 ID' },
    },
    required: ['archId'],
  },

  async execute(params: unknown, _ctx: TaskContext): Promise<ToolResult> {
    const raw = (params ?? {}) as Record<string, unknown>
    const archId = typeof raw.archId === 'number' ? raw.archId : undefined
    if (!archId) {
      return { success: false, output: 'archId 为必填参数' }
    }

    const doc = await getArchDocumentById(archId)
    if (!doc) {
      return { success: false, output: `找不到架构文档 #${archId}` }
    }

    const hasStructured = !!(doc.contentJson as Record<string, unknown>)?.structuredArch

    const header = [
      `## 架构文档 #${doc.id}`,
      `**标题:** ${doc.title}`,
      `**状态:** ${doc.status}`,
      `**版本:** ${doc.version}`,
      doc.sourcePrdId ? `**关联 PRD:** #${doc.sourcePrdId}` : '',
      `**更新时间:** ${doc.updatedAt.toISOString().slice(0, 10)}`,
      hasStructured ? '**模式:** structured (V1)' : '**模式:** markdown',
    ].filter(Boolean).join('\n')

    return {
      success: true,
      output: `${header}\n\n---\n\n${doc.contentMarkdown ?? '（暂无内容）'}`,
      data: {
        archId: doc.id,
        title: doc.title,
        status: doc.status,
        sourcePrdId: doc.sourcePrdId,
        hasStructured,
        structuredArch: hasStructured
          ? (doc.contentJson as Record<string, unknown>).structuredArch
          : undefined,
      },
    }
  },
}

registerTool(readArchTool)
