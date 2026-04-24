/**
 * 统一错误提取：axios 错误时把 GitLab 返回的真实 message 挖出来。
 *
 * axios 错误的 err.message 往往只说 "Request failed with status code 404"，
 * GitLab 的真实原因（如 "source_branch not found"）藏在 err.response.data.message。
 * 这个 helper 统一抽取，供所有 PRD submit 相关 handler 使用。
 */
import axios from 'axios'

export function extractErrorMessage(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status
    const data = err.response?.data

    if (typeof data === 'string') {
      // GitLab 偶尔返回纯文本错误（如 HTML 错误页）
      return `HTTP ${status ?? '?'}: ${data.slice(0, 300)}`
    }
    if (data && typeof data === 'object') {
      const rec = data as Record<string, unknown>
      // GitLab API 错误字段优先级: message > error > error_description
      const msg = rec.message ?? rec.error ?? rec.error_description
      if (typeof msg === 'string') {
        return `HTTP ${status ?? '?'}: ${msg}`
      }
      if (Array.isArray(msg)) {
        // GitLab 有时返回数组（如 validation errors）
        return `HTTP ${status ?? '?'}: ${msg.join('; ')}`
      }
    }
    if (status) return `HTTP ${status}: ${err.message}`
    return err.message
  }
  return err instanceof Error ? err.message : String(err)
}
