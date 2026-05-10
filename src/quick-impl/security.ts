/**
 * Quick-Impl 安全工具：rawInput 入队前的敏感信息脱敏。
 *
 * 设计：docs/prds/quick-impl-roles-v2/07-risks-ops.md §2.1
 * 风险：用户在 rawInput 输入框可能粘贴 API key / 密码 / GitLab token / 内网 URL，
 *       当前会原样发到 Anthropic API → 违反数据合规。
 */

export interface SanitizeHit {
  type: 'gitlab-token' | 'api-key' | 'bearer' | 'email' | 'internal-ip'
  /** 原始片段长度（不写原始内容到 log，避免日志泄露） */
  originalLength: number
  /** 命中起始 index */
  startIndex: number
}

export interface SanitizeResult {
  sanitized: string
  hits: SanitizeHit[]
}

/**
 * 脱敏规则（详见 07-risks-ops.md §2.1）。
 * 顺序很重要：更具体的模式（gitlab-token / api-key）先匹配，再到通用模式。
 */
const RULES: Array<{ type: SanitizeHit['type']; re: RegExp; replace: string }> = [
  // GitLab personal token: glpat-{20+}
  {
    type: 'gitlab-token',
    re: /glpat-[A-Za-z0-9_-]{20,}/g,
    replace: '[REDACTED:gitlab-token]',
  },
  // Anthropic / OpenAI API key: sk-{20+}
  {
    type: 'api-key',
    re: /sk-[A-Za-z0-9-]{20,}/g,
    replace: '[REDACTED:api-key]',
  },
  // Bearer token: Bearer {20+}
  {
    type: 'bearer',
    re: /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/gi,
    replace: '[REDACTED:bearer]',
  },
  // 邮箱（按合规要求脱敏；如不需要可在调用方关闭）
  {
    type: 'email',
    re: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    replace: '[REDACTED:email]',
  },
  // 内网 IP（10.0.0.0/8 + 172.16-31.0.0/12 + 192.168.0.0/16；完整 4 octet）
  {
    type: 'internal-ip',
    re: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/g,
    replace: '[REDACTED:internal-ip]',
  },
]

/**
 * 脱敏 rawInput。逐条规则替换，记录所有命中。
 *
 * 实施：[src/quick-impl/worker.ts](./worker.ts) 入队前调用。
 *
 * @param raw 用户输入的原始字符串
 * @param opts 可选：disable 某些规则
 */
export function sanitizeRawInput(
  raw: string,
  opts?: { disableEmail?: boolean },
): SanitizeResult {
  if (!raw || typeof raw !== 'string') return { sanitized: raw, hits: [] }
  const hits: SanitizeHit[] = []
  let result = raw

  for (const rule of RULES) {
    if (rule.type === 'email' && opts?.disableEmail) continue

    // 先收集 hits（在原始字符串上做 match）
    const matches = Array.from(raw.matchAll(rule.re))
    for (const m of matches) {
      hits.push({
        type: rule.type,
        originalLength: m[0].length,
        startIndex: m.index ?? 0,
      })
    }

    // 替换（在 result 上做替换；rule.re 是 /g 所以 replace 全部）
    result = result.replace(rule.re, rule.replace)
  }

  return { sanitized: result, hits }
}

/**
 * 写 warning log 到 application logger。不写原始命中内容（仅类型 + 长度）。
 */
export function logSanitizeHits(
  context: string,
  hits: SanitizeHit[],
): void {
  if (hits.length === 0) return
  const summary = hits.map((h) => `${h.type}(len=${h.originalLength})`).join(', ')
  console.warn(`[sanitize] ${context}: ${hits.length} hit(s) — ${summary}`)
}
