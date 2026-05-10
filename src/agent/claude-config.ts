/**
 * 从 system_config.claude 读取需要透传给 Claude CLI 的环境变量。
 *
 * 字段约定（与环境变量名一一对应）：
 *   - CLAUDE_CODE_OAUTH_TOKEN: OAuth token；DB 优先，否则 fallback 到启动 env var
 *   - ANTHROPIC_BASE_URL: 自定义 API 端点；空则不注入
 *
 * 任意字段为空时，都不会写入返回的 env 对象，使 Claude CLI 走默认行为。
 *
 * 另：强制覆盖 MCP_CONNECTION_NONBLOCKING 为空字符串。
 *   Claude Code SDK / VSCode 内嵌实例启动时会自动 set MCP_CONNECTION_NONBLOCKING=true
 *   让 MCP 连接完全异步（不阻塞 prompt 处理）。这个 env 会通过子进程继承泄露到
 *   chatops 进程，chatops 再 spawn Claude CLI 时就把它带进去 → CLI 启动后立刻处理 prompt
 *   而不等 MCP 注册完成 → Claude 看到的工具列表里不含 mcp__playwright__*，e2e scenario
 *   报 "No such tool available"。生产 docker env 默认无此变量，CLI 走同步分支（最多等
 *   5s 让 MCP 连上，足够 Playwright 250ms 完成）。这里显式覆盖空串恢复同步行为。
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

  // 见上方块注释：强制空串覆盖 race-y 默认。
  env.MCP_CONNECTION_NONBLOCKING = ''

  return env
}
