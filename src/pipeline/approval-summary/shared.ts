/**
 * 审批摘要拼装的共享 helper：
 *   - computeHeuristicHint: 启发式审批建议（"看起来可快速批" / "建议关注 high 风险" / "建议 escalation"）
 *   - parseFeedbackForSummary: 从 feedback.md 提取拒绝原因 + reviewer 标记两段
 *   - truncateImSummary: IM 摘要长度硬限（默认 250 字符）
 *   - formatStandard: standardsConsulted union 渲染
 */
import type { SpecAuthorOutput } from '../../quick-impl/role-output-schemas.js'
import { SpecSummaryI18n } from './i18n.js'

/**
 * 启发式审批助手 hint。优先级：reviewHints.high > risks.high > round≥3 > confidenceLevel='high'
 * 矛盾时偏向 conservative（高风险优先于"可快速批"）
 */
export function computeHeuristicHint(args: {
  skillOutput: SpecAuthorOutput | null
  round: number
  budgetExtended?: boolean
}): string {
  const { skillOutput, round, budgetExtended } = args
  if (!skillOutput) return ''

  const reviewHints = skillOutput.reviewHints ?? []
  if (reviewHints.some((h) => h.severity === 'high')) return SpecSummaryI18n.HINT_HIGH_RISK

  const risks = skillOutput.risks ?? []
  if (risks.some((r) => r.severity === 'high')) return SpecSummaryI18n.HINT_HIGH_RISK

  if (round >= 3 || budgetExtended) return SpecSummaryI18n.HINT_ESCALATION

  if (skillOutput.confidenceLevel === 'high') return SpecSummaryI18n.HINT_QUICK_PASS

  return ''
}

/**
 * 从 feedback.md（renderFeedbackMarkdown 产出）提取两段最常用的内容：
 *   - 拒绝原因（"## 拒绝原因" / "## reject reasons"）
 *   - Reviewer 标记（"## Reviewer 标记" / "## 注意事项"）
 *
 * 解析失败 → 两段都返回空数组（调用方可降级显示原文截断）。
 */
export function parseFeedbackForSummary(md: string): {
  rejectReasons: string[]
  reviewerNotes: string[]
} {
  if (!md) return { rejectReasons: [], reviewerNotes: [] }

  const rejectSection = extractSection(md, /^##\s*(拒绝原因|reject\s*reasons?)/im)
  const rejectReasons = rejectSection
    ? rejectSection
        .split('\n')
        .filter((l) => l.startsWith('>') && l.length > 1)
        .map((l) => l.replace(/^>\s*/, '').trim())
        .filter(Boolean)
    : []

  const reviewerSection = extractSection(md, /^##\s*(reviewer\s*标记|reviewer\s*notes?|注意事项)/im)
  const reviewerNotes = reviewerSection
    ? reviewerSection
        .split('\n')
        .filter((l) => /^[-*]\s/.test(l))
        .map((l) => l.replace(/^[-*]\s*/, '').trim())
        .filter(Boolean)
    : []

  return { rejectReasons, reviewerNotes }
}

function extractSection(md: string, headerRe: RegExp): string | null {
  const match = headerRe.exec(md)
  if (!match) return null
  const start = match.index + match[0].length
  const rest = md.slice(start)
  const next = /^##\s/m.exec(rest)
  return next ? rest.slice(0, next.index) : rest
}

/** IM 摘要长度硬限（≤ max 字符；默认 250）*/
export function truncateImSummary(s: string, max = 250): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1).trimEnd() + '…'
}

/** standardsConsulted union 渲染（兼容老 string 元素 / 新 {file, usedFor} 对象）*/
export function formatStandard(s: string | { file: string; usedFor: string }): string {
  return typeof s === 'string' ? s : `${s.file} — ${s.usedFor}`
}

/** 风险等级 emoji 标记 */
export function riskIcon(severity: 'high' | 'medium' | 'low'): string {
  return severity === 'high' ? '🔴' : severity === 'medium' ? '🟡' : '🟢'
}
