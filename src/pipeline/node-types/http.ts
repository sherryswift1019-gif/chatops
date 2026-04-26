import { registerNodeType } from './registry.js'
import type { ExecutionContext, NodeExecutionResult } from './types.js'

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
 *
 * 成功语义: status 2xx → status='success', output={statusCode, headers, body}
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
    _ctx: ExecutionContext,
  ): Promise<NodeExecutionResult> {
    const method = String(params.method ?? 'GET').toUpperCase()
    const url = params.url as string | undefined
    if (!url) {
      return { status: 'failed', output: {}, error: 'http executor requires params.url' }
    }
    const headers = (params.headers ?? {}) as Record<string, string>
    const timeoutMs = typeof params.timeoutMs === 'number' ? params.timeoutMs : 30000

    let bodyInit: BodyInit | undefined
    if (params.body !== undefined && params.body !== null && method !== 'GET' && method !== 'HEAD') {
      if (typeof params.body === 'string') {
        bodyInit = params.body
      } else {
        bodyInit = JSON.stringify(params.body)
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
        output: { statusCode: res.status, headers: respHeaders, body: parsedBody },
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
