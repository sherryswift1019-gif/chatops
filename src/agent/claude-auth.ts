/**
 * 根据 token 前缀，构造传给 Claude CLI 的环境变量。
 *
 * Claude CLI 区分两种凭证:
 *   - 普通 API key (sk-ant-api03-*)   → 走 ANTHROPIC_API_KEY
 *   - OAuth Access Token (sk-ant-oat01-*) → 走 CLAUDE_CODE_OAUTH_TOKEN
 *
 * 如果把 OAT 错误地放到 ANTHROPIC_API_KEY，Claude CLI 可能把它当作 API key
 * 直接调 API 验证，偶发 "Invalid API key · Fix external API key" 失败。
 */
export function buildClaudeAuthEnv(token: string | undefined): Record<string, string> {
  const t = token ?? ''
  if (!t) return {}
  if (t.startsWith('sk-ant-oat01-')) {
    return { CLAUDE_CODE_OAUTH_TOKEN: t }
  }
  return { ANTHROPIC_API_KEY: t }
}
