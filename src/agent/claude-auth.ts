/**
 * 构造传给 Claude CLI 子进程的认证环境变量。
 *
 * 兼容两种模式：
 *   模式 1（API Key）：.env 中配了有效的 ANTHROPIC_API_KEY（sk-ant-api03-*）
 *     → 直接传 ANTHROPIC_API_KEY 给 Claude CLI
 *
 *   模式 2（OAuth / 网关）：.env 没配 API Key，shell 环境有 CLAUDE_CODE_OAUTH_TOKEN + ANTHROPIC_BASE_URL
 *     → 传 CLAUDE_CODE_OAUTH_TOKEN + ANTHROPIC_BASE_URL 给 Claude CLI（走内网代理）
 *
 * 优先级：模式 1 > 模式 2（有 API Key 就用 API Key，没有才 fallback 到 OAuth）
 */
export function buildClaudeAuthEnv(apiKey: string | undefined): Record<string, string> {
  const env: Record<string, string> = {}
  const key = apiKey ?? ''

  // 模式 1：有效的 API Key（长度 >20 且非占位符）
  if (key.length > 20) {
    if (key.startsWith('sk-ant-oat01-')) {
      // OAuth token 误放到了 ANTHROPIC_API_KEY
      env.CLAUDE_CODE_OAUTH_TOKEN = key
    } else {
      env.ANTHROPIC_API_KEY = key
    }
    // API Key 模式也可能需要自定义 base URL
    if (process.env.ANTHROPIC_BASE_URL) {
      env.ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL
    }
    return env
  }

  // 模式 2：Fallback 到 shell 环境的 OAuth token（网关模式）
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
  if (oauthToken) {
    env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken
  }
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  if (baseUrl) {
    env.ANTHROPIC_BASE_URL = baseUrl
  }

  return env
}
