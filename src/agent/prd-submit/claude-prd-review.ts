/**
 * claude-prd-review — 调 Claude CLI 对 PRD MR diff 做结构化 review。
 *
 * 输入：MR unified diff + system prompt（来自 capabilities.system_prompt）
 * 输出：{ decision: 'pass'|'blocked', findings[], markdown, parseFailed? }
 *
 * 解析策略（两段式）：
 *   1. 尝试从输出里抽 JSON（先整段 parse，失败则找 JSON 对象子串）
 *   2. JSON 不 well-formed / 字段缺失 → 启发式 fallback：
 *      - 关键字判定 decision（'blocked' 出现 → blocked；否则 pass）
 *      - findings: []
 *      - markdown: 原 raw 输出
 *      - parseFailed: true
 *
 * 与 claude-review.ts（ai_review_mr）不同：
 *   - 本 runner **不 acquire worktree**（MVP 仅看 diff，不做跨文档一致性校验）
 *   - 输出契约是 JSON，不是自由文本加 label 关键字
 */
import { getClaudeExecutor } from '../claude-executor.js'
import { isClaudeMock, popMockResponseValidated } from '../mocks/e2e-store.js'

export interface ReviewFinding {
  severity: 'blocker' | 'warning' | 'info'
  title: string
  detail?: string
}

export interface PrdReviewResult {
  decision: 'pass' | 'blocked'
  findings: ReviewFinding[]
  markdown: string
  parseFailed?: boolean
}

export interface RunClaudePrdReviewInput {
  mrDiff: string
  systemPrompt: string
  /** Claude CLI 空闲超时（默认 600s，对齐 claude-review.ts） */
  timeoutMs?: number
  signal?: AbortSignal
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000 // 600s

function tryParseJson(raw: string): PrdReviewResult | null {
  const trimmed = raw.trim()
  // 直接整段 parse
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>
    if (isValidReviewResult(obj)) return normalizeReviewResult(obj)
  } catch {
    // fall through
  }

  // 退而求其次：找第一个 `{` 到最后一个 `}` 的子串
  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  if (first >= 0 && last > first) {
    const candidate = trimmed.slice(first, last + 1)
    try {
      const obj = JSON.parse(candidate) as Record<string, unknown>
      if (isValidReviewResult(obj)) return normalizeReviewResult(obj)
    } catch {
      // fall through
    }
  }

  return null
}

function isValidReviewResult(obj: Record<string, unknown>): boolean {
  if (obj.decision !== 'pass' && obj.decision !== 'blocked') return false
  if (!Array.isArray(obj.findings)) return false
  // markdown 字段可选——Claude 偶尔会省略它只给 decision+findings。
  // 缺失时 normalizeReviewResult 会从 findings 合成一段。
  return true
}

/**
 * 从 decision + findings 合成一段供 MR 评论展示的 Markdown。
 * 仅在 Claude 返回的 JSON 含 decision+findings 但漏 markdown 字段时触发。
 */
function synthesizeMarkdown(
  decision: 'pass' | 'blocked',
  findings: ReviewFinding[],
): string {
  const header = decision === 'pass'
    ? '**结论**: ✅ pass'
    : '**结论**: ⚠️ blocked'
  if (findings.length === 0) {
    return `${header}\n\n_Claude 未给出具体 findings_`
  }
  const lines = [header, '', '**Findings**:']
  for (const f of findings) {
    const sev = f.severity === 'blocker' ? '🛑 blocker'
      : f.severity === 'warning' ? '⚠️ warning'
      : 'ℹ️ info'
    lines.push(`- [${sev}] **${f.title}**${f.detail ? `\n  ${f.detail}` : ''}`)
  }
  return lines.join('\n')
}

function normalizeReviewResult(obj: Record<string, unknown>): PrdReviewResult {
  const findings: ReviewFinding[] = (obj.findings as unknown[]).map(f => {
    const rec = f as Record<string, unknown>
    const sev: ReviewFinding['severity'] =
      rec.severity === 'blocker' || rec.severity === 'warning' || rec.severity === 'info'
        ? rec.severity
        : 'warning'
    return {
      severity: sev,
      title: typeof rec.title === 'string' ? rec.title : '(无标题)',
      detail: typeof rec.detail === 'string' ? rec.detail : undefined,
    }
  })
  const decision = obj.decision as 'pass' | 'blocked'
  const markdown = typeof obj.markdown === 'string' && obj.markdown.trim()
    ? obj.markdown
    : synthesizeMarkdown(decision, findings)
  return {
    decision,
    findings,
    markdown,
  }
}

/**
 * 启发式 fallback：JSON 解析失败时用字符串关键词粗判。
 * 默认偏保守：decision 缺省 blocked（宁可多一轮人工 review，也不放过问题 PRD）。
 */
function heuristicFallback(raw: string): PrdReviewResult {
  const lower = raw.toLowerCase()
  // 出现 blocked/reject/阻塞 等关键字 → blocked；否则保守 blocked（见下注释）
  const hasBlocked = /\b(blocked|reject|阻塞|不通过)\b/.test(lower)
  const hasPassed = /\b(pass|approve|通过|无问题)\b/.test(lower) && !hasBlocked

  return {
    decision: hasPassed ? 'pass' : 'blocked', // 默认保守 blocked
    findings: [],
    markdown: [
      '## 🤖 AI Review（解析降级）',
      '',
      'Claude 输出未能解析为结构化 JSON，下面是原始输出：',
      '',
      '```',
      raw.length > 4000 ? raw.slice(0, 4000) + '\n...(truncated)' : raw,
      '```',
      '',
      hasPassed
        ? '_启发式判定：pass_'
        : '_启发式判定：blocked（保守取向，建议人工核查后 push 新 commit 再跑一次 review）_',
    ].join('\n'),
    parseFailed: true,
  }
}

export async function runClaudePrdReview(
  input: RunClaudePrdReviewInput,
): Promise<PrdReviewResult> {
  // e2e mock 路径：整段响应可被测试桩覆盖
  if (isClaudeMock()) {
    return popMockResponseValidated<PrdReviewResult>('prd-review', ['decision', 'findings', 'markdown'])
  }

  const prompt = [
    input.systemPrompt,
    '',
    '---',
    '',
    '下面是本次 PRD MR 的 unified diff，请按上面要求审查：',
    '',
    input.mrDiff,
  ].join('\n')

  const raw = await getClaudeExecutor().run({
    prompt,
    // 严格限制：不给 Read/Glob/Grep，MVP 只看 diff，不做跨文档一致性校验
    allowedTools: '',
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    signal: input.signal,
    onEvent: (e) => console.log(`[prd-review] ${e.type}: ${e.message}`),
  })

  const parsed = tryParseJson(raw)
  if (parsed) return parsed

  console.warn('[prd-review] JSON 解析失败，走启发式 fallback；raw length:', raw.length)
  return heuristicFallback(raw)
}
