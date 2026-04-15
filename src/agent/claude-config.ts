/**
 * 从 system_config.claude 读取需要透传给 Claude CLI 的环境变量。
 *
 * 字段约定（与环境变量名一一对应）：
 *   - CLAUDE_CODE_OAUTH_TOKEN: OAuth token；DB 优先，否则 fallback 到启动 env var
 *   - ANTHROPIC_BASE_URL: 自定义 API 端点；空则不注入
 *
 * 任意字段为空时，都不会写入返回的 env 对象，使 Claude CLI 走默认行为。
 */
import { getConfig } from '../db/repositories/system-config.js'

export async function buildClaudeEnv(): Promise<Record<string, string>> {
  const cfg = await getConfig('claude')
  const v = (cfg?.value ?? {}) as Record<string, unknown>
  const env: Record<string, string> = {}

  const dbToken = typeof v.CLAUDE_CODE_OAUTH_TOKEN === 'string' ? v.CLAUDE_CODE_OAUTH_TOKEN.trim() : ''
  const token = dbToken || (process.env.CLAUDE_CODE_OAUTH_TOKEN ?? '').trim()
  if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token

  const baseUrl = typeof v.ANTHROPIC_BASE_URL === 'string' ? v.ANTHROPIC_BASE_URL.trim() : ''
  if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl

  return env
}
