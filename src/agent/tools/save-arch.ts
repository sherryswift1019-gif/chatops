import { registerTool } from './index.js'
import type { AgentTool, TaskContext, ToolResult } from './types.js'
import {
  createArchDocument,
  getArchDocumentById,
  updateArchDocument,
} from '../../db/repositories/arch-documents.js'
import { runMechanicalCheck } from '../arch/mechanical-check.js'
import { renderArchDocument } from '../arch/renderer.js'
import type { StructuredArch } from '../arch/structured-types.js'

/**
 * save_arch — 保存架构设计文档
 *
 * 双签名（V1）：
 *  - 首选 `structured`（StructuredArch）：服务端跑 mechanicalCheck → 通过后渲染 Markdown → 入库
 *  - 兼容 `contentMarkdown`：不做机械校验，直接入库
 *
 * 首次保存省略 archId，更新请传 archId。
 */
const saveArchTool: AgentTool = {
  name: 'save_arch',
  description:
    '保存架构设计文档。推荐传 `structured`（StructuredArch）以触发机械校验 + Mermaid 完整性验证；' +
    '也可传 `contentMarkdown` 直接入库（兼容模式）。' +
    '首次保存省略 archId；更新时传 archId。',
  riskLevel: 'low',
  inputSchema: {
    type: 'object',
    properties: {
      archId: {
        type: 'number',
        description: '已有架构文档 ID（更新模式）；首次创建请省略',
      },
      structured: {
        type: 'object',
        description:
          '结构化入参（推荐）。服务端先跑机械校验，失败返回 errors 数组；通过后按 13 章节模板渲染为 Markdown 并入库。',
      },
      title: {
        type: 'string',
        description: '架构文档标题。传 structured 时可省略（从 structured.meta.title 取）。',
      },
      contentMarkdown: {
        type: 'string',
        description: '兼容模式：直接传完整 Markdown。传 structured 时忽略。',
      },
    },
    required: [],
  },

  async execute(params: unknown, ctx: TaskContext): Promise<ToolResult> {
    const raw = (params ?? {}) as Record<string, unknown>
    const archId = typeof raw.archId === 'number' ? raw.archId : undefined

    // ── 结构化模式 ──────────────────────────────────────────────────────────
    if (raw.structured && typeof raw.structured === 'object') {
      const arch = raw.structured as StructuredArch

      // 确保 meta 中含产品线 ID（从 context 注入）
      if (!arch.meta.productLineId && ctx.productLineId) {
        arch.meta.productLineId = ctx.productLineId
      }

      const { passed, blockers, warnings } = runMechanicalCheck(arch)
      if (!passed) {
        const errorLines = blockers.map(e => `[${e.ruleId}] ${e.message}`)
        return {
          success: false,
          output:
            `机械校验未通过（${blockers.length} 条 blocker），架构文档未保存。\n\n` +
            `请根据以下问题回到对话中补充信息后重新调用 save_arch：\n${errorLines.join('\n')}`,
          data: { blockers, warnings },
        }
      }

      const title = arch.meta.title || (typeof raw.title === 'string' ? raw.title : '未命名架构文档')
      const markdown = renderArchDocument(arch)
      const contentJson = { structuredArch: arch }

      let doc
      if (archId) {
        doc = await updateArchDocument(archId, {
          title,
          contentMarkdown: markdown,
          contentJson,
          version: undefined,
          agentSessionId: ctx.taskId,
        })
        if (!doc) {
          return { success: false, output: `找不到架构文档 #${archId}` }
        }
      } else {
        doc = await createArchDocument({
          productLineId: arch.meta.productLineId ?? ctx.productLineId ?? 0,
          sourcePrdId: arch.meta.sourcePrdId ?? null,
          title,
          contentMarkdown: markdown,
          contentJson,
          createdBy: ctx.initiatorId,
          agentSessionId: ctx.taskId,
        })
      }

      const warnText = warnings.length
        ? `\n\n⚠️ ${warnings.length} 条 warning（不阻断）：${warnings.map(w => w.message).join('；')}`
        : ''

      return {
        success: true,
        output: `架构文档已保存（ID: ${doc.id}，模式: structured）。${warnText}`,
        data: { archId: doc.id, mode: 'structured', warnings },
      }
    }

    // ── 兼容模式：直接 Markdown ─────────────────────────────────────────────
    const markdown = typeof raw.contentMarkdown === 'string' ? raw.contentMarkdown : ''
    const title = typeof raw.title === 'string' ? raw.title : '未命名架构文档'
    if (!markdown.trim()) {
      return { success: false, output: '必须提供 structured 或 contentMarkdown' }
    }

    let doc
    if (archId) {
      doc = await updateArchDocument(archId, {
        title,
        contentMarkdown: markdown,
        agentSessionId: ctx.taskId,
      })
      if (!doc) return { success: false, output: `找不到架构文档 #${archId}` }
    } else {
      doc = await createArchDocument({
        productLineId: ctx.productLineId ?? 0,
        title,
        contentMarkdown: markdown,
        contentJson: {},
        createdBy: ctx.initiatorId,
        agentSessionId: ctx.taskId,
      })
    }

    return {
      success: true,
      output: `架构文档已保存（ID: ${doc.id}，模式: markdown）`,
      data: { archId: doc.id, mode: 'markdown' },
    }
  },
}

registerTool(saveArchTool)
