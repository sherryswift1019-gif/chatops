import { registerNodeType } from './registry.js'
import type { ExecutionContext, NodeExecutionResult } from './types.js'
import { resolveVariables, type VariableContext } from '../variables.js'

/**
 * Phase 3 T9 — http executor。
 *
 * 用 Node 内建 `fetch`(Node 18+)发起 HTTP 请求。
 *
 * params:
 *   - method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
 *   - url: string (必填; 调度方负责把 {{vars.x}} 等模板预解析掉)
 *   - headers?: Record<string, string>
 *   - body?: unknown (object 自动 JSON.stringify; string 原样)
 *   - timeoutMs?: number (默认 30000)
 *   - extraMeta?: Record<string, unknown> (phase 4 T4 新增)
 *       原样透传到 success output —— fan_out 内调用 http 时，下游 db_update 节点
 *       通过 `{{steps.fanOut.output.items[i].extraMeta.x}}` 拿到 fan_out 注入的元数据
 *       (project_path / branch / isPrimary 等) 写 bug_fix_events。failed 路径上
 *       fan_out 已经把整个 item 一起写到 output.failed[i].item，所以 failed 路径
 *       不需要 extraMeta。与 dm 节点同模式（phase 4 T3）。
 *
 * 模板解析（phase 4 T4 扩展）：
 *   外层 graph-builder 在调度本节点前已对 params 字符串做过 renderParamTemplates，
 *   但当 http 节点被 fan_out body 调用时，{{proj.xxx}} 这类 scope 引用
 *   在外层 ctx.scopes 为空时无法解析（保留为 literal）。http executor 在内部再
 *   过一次 resolveVariables —— 此时 fan_out 已把 item 注入 ctx.scopes，
 *   {{proj.project_path}} 等模板可正确解析。与 dm / template_render 同模式。
 *
 * 成功语义: status 2xx → status='success', output={statusCode, headers, body, ...(extraMeta?)}
 * 失败语义:
 *   - 4xx/5xx: status='failed', output 同上, error='HTTP <code>'
 *   - timeout: status='failed', output={timedOut:true}, error='timeout'
 *   - 网络/解析异常: status='failed', error=异常消息
 *
 * 不做重试 —— retry 由 graph-runner 的 retry_when 表达式控制。
 */
registerNodeType({
  key: 'http',
  async execute(
    params: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<NodeExecutionResult> {
    const varCtx = buildVariableContext(ctx)

    const method = String(params.method ?? 'GET').toUpperCase()
    const url = renderIfString(params.url, varCtx)
    if (!url) {
      return { status: 'failed', output: {}, error: 'http executor requires params.url' }
    }
    const headers = renderHeaders(params.headers, varCtx)
    const timeoutMs = typeof params.timeoutMs === 'number' ? params.timeoutMs : 30000
    const extraMeta = resolveExtraMeta(params.extraMeta, varCtx)

    let bodyInit: BodyInit | undefined
    if (params.body !== undefined && params.body !== null && method !== 'GET' && method !== 'HEAD') {
      const renderedBody = renderBody(params.body, varCtx)
      if (typeof renderedBody === 'string') {
        bodyInit = renderedBody
      } else {
        bodyInit = JSON.stringify(renderedBody)
        if (!Object.keys(headers).some(k => k.toLowerCase() === 'content-type')) {
          headers['Content-Type'] = 'application/json'
        }
      }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: bodyInit,
        signal: controller.signal,
      })
      clearTimeout(timer)
      const respHeaders: Record<string, string> = {}
      res.headers.forEach((v, k) => { respHeaders[k] = v })
      const text = await res.text()
      let parsedBody: unknown = text
      const ct = respHeaders['content-type'] ?? ''
      if (ct.includes('application/json') && text.length > 0) {
        try { parsedBody = JSON.parse(text) } catch { parsedBody = text }
      }
      const success = res.status >= 200 && res.status < 300
      return {
        status: success ? 'success' : 'failed',
        output: {
          statusCode: res.status,
          headers: respHeaders,
          body: parsedBody,
          ...(success && extraMeta ? { extraMeta } : {}),
        },
        ...(success ? {} : { error: `HTTP ${res.status}` }),
      }
    } catch (err) {
      clearTimeout(timer)
      const isAbort = err instanceof Error && err.name === 'AbortError'
      if (isAbort) {
        return { status: 'failed', output: { timedOut: true }, error: 'timeout' }
      }
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

function renderHeaders(
  raw: unknown,
  varCtx: VariableContext & Record<string, unknown>,
): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') {
      out[k] = v.includes('{{') ? resolveVariables(v, varCtx as VariableContext) : v
    } else {
      out[k] = String(v)
    }
  }
  return out
}

/**
 * body 内部值也走一次模板解析（fan_out body 里的 url/headers/body 字段
 * 通常含 "{{proj.xxx}}" 字符串引用）。仅 1 层深 —— 与 dm 节点的 extraMeta
 * 同模式。深嵌套场景未来再扩展。
 *
 * 字符串值: 走 resolveVariables; 若 rendered 形如 "true"/"false"/"123" 则转回
 *   primitive (因为 GitLab API 期望 boolean / number, 而不是字符串)。
 * 非字符串值: 原样保留。
 */
function renderBody(
  raw: unknown,
  varCtx: VariableContext & Record<string, unknown>,
): unknown {
  if (typeof raw === 'string') {
    if (!raw.includes('{{')) return raw
    return resolveVariables(raw, varCtx as VariableContext)
  }
  if (!raw || typeof raw !== 'object') return raw
  if (Array.isArray(raw)) return raw
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' && v.includes('{{')) {
      const rendered = resolveVariables(v, varCtx as VariableContext)
      out[k] = coerceScalar(rendered)
    } else {
      out[k] = v
    }
  }
  return out
}

/**
 * extraMeta 内部值也走一次模板解析。与 dm.ts:resolveExtraMeta 同实现 ——
 * 仅 1 层深, 字符串值走 resolveVariables; 解析后形如 JSON array/object 时尝试 parse 回来。
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

/**
 * 字符串渲染后若是合法 number / boolean / null,转回 primitive 类型。
 * 其它情况保留 string。
 */
function coerceScalar(s: string): unknown {
  if (s === 'true') return true
  if (s === 'false') return false
  if (s === 'null') return null
  if (/^-?\d+$/.test(s)) {
    const n = Number(s)
    if (Number.isFinite(n) && String(n) === s) return n
  }
  if (/^-?\d+\.\d+$/.test(s)) {
    const n = Number(s)
    if (Number.isFinite(n)) return n
  }
  return s
}
