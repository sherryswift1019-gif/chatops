import { registerTool } from './index.js'
import type { AgentTool, TaskContext, ToolResult } from './types.js'
import {
  createPrdDocument,
  getPrdDocumentById,
  updatePrdContent,
  mergePrdMetrics,
} from '../../db/repositories/prd-documents.js'
import { mechanicalValidate } from '../prd/mechanical-check.js'
import { renderPrdMarkdown } from '../prd/renderer.js'
import { RULES_VERSION } from '../prd/rules.js'
import type { MechanicalError, StructuredPrd } from '../prd/structured-types.js'

type SaveMode = 'structured' | 'markdown'

/**
 * save_prd 双签名（V2.0）：
 *  - 首选 `structured`：服务端跑 mechanicalValidate → 通过后 renderPrdMarkdown → 入库
 *    content_markdown 为渲染产物，content_json.structuredPrd / rulesVersion 同步写入
 *  - V1 兼容 `contentMarkdown`：不做机械校验，直接入库；content_json.structuredPrd 缺省
 *
 * 见 docs/prds/prd-agent-v2-iteration.md §5.1 / §5.3。
 */
const savePrdTool: AgentTool = {
  name: 'save_prd',
  description:
    'V2 推荐：传 `structured`（StructuredPrd）以触发机械校验 + 模板渲染；V1 兼容 `contentMarkdown`。首次保存省略 prdId，更新请传 prdId。保存后系统自动触发自审。',
  riskLevel: 'low',
  inputSchema: {
    type: 'object',
    properties: {
      prdId: { type: 'number', description: '已有 PRD 的 ID（更新模式）；首次创建请省略' },
      structured: {
        type: 'object',
        description:
          'V2 结构化入参（推荐）。服务端先跑机械校验，失败返回 errors 数组；通过后按模板渲染为 Markdown 并入库。字段结构见 StructuredPrd 类型。',
      },
      title: {
        type: 'string',
        description: 'PRD 标题。传 structured 时可省略（从 structured.meta.title 取）。',
      },
      contentMarkdown: {
        type: 'string',
        description: 'V1 兼容：完整 Markdown。传 structured 时忽略。',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: '可选标签（如 ["用户管理","二期"]）',
      },
    },
    required: [],
  },

  async execute(params: unknown, ctx: TaskContext): Promise<ToolResult> {
    const raw = (params ?? {}) as Record<string, unknown>
    const prdId = typeof raw.prdId === 'number' ? raw.prdId : undefined
    const tags = Array.isArray(raw.tags) ? (raw.tags as string[]) : undefined

    const structuredInput =
      raw.structured && typeof raw.structured === 'object' && !Array.isArray(raw.structured)
        ? (raw.structured as StructuredPrd)
        : null
    const mode: SaveMode = structuredInput ? 'structured' : 'markdown'

    let title = ''
    let contentMarkdown = ''
    let contentJson: Record<string, unknown> | undefined

    if (structuredInput) {
      const errors = mechanicalValidate(structuredInput)
      if (errors.length > 0) {
        return {
          success: false,
          output: formatMechanicalErrors(errors),
          data: { mode, mechanicalErrors: errors },
        }
      }

      contentMarkdown = renderPrdMarkdown(structuredInput)
      contentJson = {
        structuredPrd: structuredInput,
        rulesVersion: RULES_VERSION,
      }

      title =
        pickTitle(raw.title) ||
        pickTitle(structuredInput.meta?.title) ||
        extractTitleFromMarkdown(contentMarkdown) ||
        ''
    } else {
      contentMarkdown =
        (typeof raw.contentMarkdown === 'string' && raw.contentMarkdown) ||
        (typeof raw.content === 'string' && raw.content) ||
        (typeof raw.markdown === 'string' && raw.markdown) ||
        ''
      title = pickTitle(raw.title) || extractTitleFromMarkdown(contentMarkdown) || ''
    }

    if (!contentMarkdown) {
      return {
        success: false,
        output:
          mode === 'structured'
            ? '结构化 PRD 渲染结果为空，渲染器异常。'
            : '缺少 PRD 正文。请首选 `structured` 走 V2 路径，或用 `contentMarkdown` 传入完整 Markdown（兼容别名 `content`/`markdown`）。',
      }
    }
    if (!title) {
      return {
        success: false,
        output:
          '缺少 PRD 标题。请显式传入 `title`，或确保 `structured.meta.title` / Markdown 首行 `# 标题` 非空。',
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
        const nextContentJson = contentJson
          ? { ...existing.contentJson, ...contentJson }
          : undefined
        const updated = await updatePrdContent(prdId, {
          title,
          contentMarkdown,
          contentJson: nextContentJson,
          tags,
          agentSessionId: ctx.taskId,
        })
        if (!updated) {
          return { success: false, output: `PRD #${prdId} 更新失败` }
        }
        await mergePrdMetrics(updated.id, {
          llmCallsDelta: { create: 1 },
          rulesVersion: structuredInput ? RULES_VERSION : undefined,
        })
        return {
          success: true,
          output: formatSuccess('updated', updated.id, updated.version, mode),
          data: {
            prdId: updated.id,
            version: updated.version,
            status: updated.status,
            mode,
          },
        }
      }

      const created = await createPrdDocument({
        productLineId: productLineId!,
        title,
        contentMarkdown,
        contentJson,
        createdBy: ctx.initiatorId,
        groupId: ctx.groupId,
        platform: ctx.platform,
        agentSessionId: ctx.taskId,
        tags,
      })
      await mergePrdMetrics(created.id, {
        llmCallsDelta: { create: 1 },
        rulesVersion: structuredInput ? RULES_VERSION : undefined,
      })
      return {
        success: true,
        output: formatSuccess('created', created.id, created.version, mode, created.title),
        data: {
          prdId: created.id,
          version: created.version,
          status: created.status,
          mode,
        },
      }
    } catch (err) {
      return {
        success: false,
        output: `保存 PRD 失败：${err instanceof Error ? err.message : String(err)}`,
      }
    }
  },
}

function pickTitle(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function extractTitleFromMarkdown(md: string): string {
  const h1 = md.match(/^#\s+(.+?)\s*$/m)
  return h1 ? h1[1].trim() : ''
}

function formatMechanicalErrors(errors: MechanicalError[]): string {
  const lines = errors.map(
    (e, i) => `${i + 1}. [${e.ruleId}] ${e.field} — ${e.message}`
  )
  return [
    `机械校验未通过（${errors.length} 条），请按以下提示修正 structured 入参后重新调用 save_prd：`,
    ...lines,
  ].join('\n')
}

function formatSuccess(
  kind: 'created' | 'updated',
  id: number,
  version: number,
  mode: SaveMode,
  title?: string
): string {
  const tag = mode === 'structured' ? `, ${RULES_VERSION}` : ''
  if (kind === 'created') {
    return `✅ PRD #${id}「${title ?? ''}」已创建（v${version}${tag}）。系统将触发自审。`
  }
  return `✅ PRD #${id} 已更新（v${version}${tag}）。系统将触发自审。`
}

registerTool(savePrdTool)
export { savePrdTool }
