import { registerNodeType } from './registry.js'
import type { ExecutionContext, NodeExecutionResult } from './types.js'
import { sendImDirect } from '../im-notifier.js'
import { resolveVariables, type VariableContext } from '../variables.js'

/**
 * Phase 3 T10 — dm executor。
 *
 * 通过 IM adapter 给指定 user 发私聊文本消息。
 * 真正的 IMAdapter.sendDirectMessage 由 server.ts 启动时通过 registerImDmSender
 * 注入到 im-notifier 的 dm registry —— executor 不直接持有 adapter 实例。
 *
 * params:
 *   - platform: 'dingtalk' | 'feishu' (必填)
 *   - userId: string (必填)
 *   - text?: string  (与 card 二选一; v1 仅支持 text, card 字段忽略并回 fail)
 *   - card?: object (v1 不支持; 给出 explicit error)
 *   - extraMeta?: Record<string, unknown> (phase 4 T3 新增)
 *       原样透传到 success output —— fan_out 内调用 dm 时，下游 db_update 节点
 *       通过 `{{steps.fanOut.output.items[i].extraMeta.x}}` 拿到 owner 元数据写
 *       bug_fix_events(code='notify')。failed 路径上 fan_out 已经把整个 item
 *       一起写到 output.failed[i].item，所以 failed 路径不需要 extraMeta。
 *
 * 模板解析（phase 4 T3 扩展）：
 *   外层 graph-builder 在调度本节点前已对 params 字符串做过 renderParamTemplates，
 *   但当 dm 节点被 fan_out body 调用时，{{owner.xxx}} 这类 scope 引用
 *   在外层 ctx.scopes 为空时无法解析（保留为 literal）。dm executor 在内部再
 *   过一次 resolveVariables —— 此时 fan_out 已把 item 注入 ctx.scopes，
 *   {{owner.message_text}} 等模板可正确解析。与 template_render 同模式。
 *
 * 成功: status='success', output={messageId, deliveredAt, ...(extraMeta?)}
 * 失败: adapter 抛错 / 平台 sender 未注册 / 无 text → status='failed', error=...
 */
registerNodeType({
  key: 'dm',
  async execute(
    params: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<NodeExecutionResult> {
    const varCtx = buildVariableContext(ctx)
    const platform = renderIfString(params.platform, varCtx)
    const userId = renderIfString(params.userId, varCtx)
    const text = renderIfString(params.text, varCtx)
    const card = params.card as Record<string, unknown> | undefined
    const extraMeta = resolveExtraMeta(params.extraMeta, varCtx)

    if (!platform) {
      return { status: 'failed', output: {}, error: 'dm executor requires params.platform' }
    }
    if (!userId) {
      return { status: 'failed', output: {}, error: 'dm executor requires params.userId' }
    }
    if (card && !text) {
      // v1 不支持 card; phase 3 v1 范围内仅文本
      return {
        status: 'failed',
        output: {},
        error: 'dm executor v1 only supports text; card is not yet implemented',
      }
    }
    if (!text) {
      return { status: 'failed', output: {}, error: 'dm executor requires params.text' }
    }

    try {
      const result = await sendImDirect(platform, userId, text)
      return {
        status: 'success',
        output: {
          messageId: result.messageId ?? '',
          deliveredAt: new Date().toISOString(),
          ...(extraMeta ? { extraMeta } : {}),
        },
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { status: 'failed', output: {}, error: msg }
    }
  },
})

function buildVariableContext(ctx: ExecutionContext): VariableContext & Record<string, unknown> {
  const mergedVars: Record<string, string> = {}
  for (const [k, v] of Object.entries(ctx.vars ?? {})) {
    mergedVars[k] = typeof v === 'string' ? v : JSON.stringify(v)
  }
  return {
    productLine: { name: '', displayName: '' },
    pipeline: { id: ctx.pipelineId, name: '' },
    run: { id: ctx.runId, triggeredBy: '', triggerType: '' },
    stage: { name: ctx.nodeId, index: 0 },
    server: ctx.server
      ? { host: ctx.server.host, port: ctx.server.port, username: ctx.server.username, name: '', role: '' }
      : { host: '', port: 0, username: '', name: '', role: '' },
    vars: mergedVars,
    steps: ctx.steps ?? {},
    triggerParams: ctx.triggerParams ?? {},
    scopes: ctx.scopes ?? {},
  }
}

function renderIfString(
  value: unknown,
  varCtx: VariableContext & Record<string, unknown>,
): string | undefined {
  if (typeof value !== 'string') return undefined
  if (!value.includes('{{')) return value
  return resolveVariables(value, varCtx as VariableContext)
}

/**
 * extraMeta 内部值也走一次模板解析（fan_out body 里 ownerId 等通常是
 * "{{owner.owner_id}}" 字符串形式）。仅 1 层深 —— 足够覆盖 design 笔记 §3.2
 * 列出的字段。深嵌套场景未来再扩展。
 */
function resolveExtraMeta(
  raw: unknown,
  varCtx: VariableContext & Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' && v.includes('{{')) {
      const rendered = resolveVariables(v, varCtx as VariableContext)
      // 如果解析后还是 JSON 形式（数组/对象被 stringify），尝试 parse 回来
      if (
        (rendered.startsWith('[') && rendered.endsWith(']')) ||
        (rendered.startsWith('{') && rendered.endsWith('}'))
      ) {
        try {
          out[k] = JSON.parse(rendered)
          continue
        } catch {
          // fallthrough
        }
      }
      out[k] = rendered
    } else {
      out[k] = v
    }
  }
  return out
}
