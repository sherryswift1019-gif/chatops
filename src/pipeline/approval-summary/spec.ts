/**
 * spec / escalation 节点的审批摘要拼装。
 *
 * 输入：spec-author 结构化输出 + spec.md 全文 + acDiff + feedback.md
 * 输出：{ web, im }
 *   - web: markdown，含"摘要 5 段 + 折叠区"，写入 waiters.context_summary
 *   - im:  ≤ 250 字符纯文本，作为钉钉/飞书卡片 body
 *
 * 5 段 web 摘要：
 *   1. 本次评估（启发式 hint + confidenceLevel + 风险等级一行）
 *   2. 需要 review 的点（reviewHints[]，按 severity 排序，前 5 条；空则显示提示）
 *   3. LLM 替你做的决定（clarifications.kind='assumption'，3 列表格，前 6 行）
 *   4. 范围（AC / e2e / refs 一行计数）
 *   5. Round 2+ 仅有：上轮反馈 ↔ 本轮 acDiff 双栏（不强对应）
 *
 * 折叠区 <details>：验收标准 / 涉及代码 / 完整澄清 Q&A / 完整 spec.md
 *   - spec.md > 50KB 时不带 open（默认收起防 ReactMarkdown 性能差）
 */
import type { SpecAuthorOutput } from '../../quick-impl/role-output-schemas.js'
import type { AcDiff } from '../../quick-impl/skill-runner.js'
import {
  computeHeuristicHint,
  parseFeedbackForSummary,
  truncateImSummary,
  formatStandard,
  riskIcon,
} from './shared.js'
import { SpecSummaryI18n, severityOrder } from './i18n.js'

const SPEC_MD_FOLD_THRESHOLD = 50_000
const REVIEW_HINTS_MAX_DISPLAY = 5
const ASSUMPTIONS_MAX_DISPLAY = 6
const IM_MAX_CHARS = 250

export interface BuildSpecApprovalSummaryArgs {
  /** spec-author 结构化输出（null 时降级为 spec.md 原文）*/
  skillOutput: SpecAuthorOutput | null
  /** spec.md 全文（用于折叠区底部完整内容）*/
  specMdContent: string
  /** 当前 round（≥1）*/
  round: number
  /** Round 2+ 的 AC 增删改 */
  acDiff?: AcDiff | null
  /** Round 2+ 的 feedback.md（renderFeedbackMarkdown 产出）*/
  feedbackMd?: string | null
  /** 上轮 spec-author 输出（用于 round 2+ 已确认 assumption 去重；本版未启用）*/
  prevSkillOutput?: SpecAuthorOutput | null
  /** budget 是否已被延期（影响 hint）*/
  budgetExtended?: boolean
  /** AI review 历史（spec_ai_review 触发 N 轮后升级人审时给审批人参考） */
  aiReviewHistory?: {
    rounds: number
    notes: Array<{ severity: string; msg: string; file?: string }>
  }
}

export function buildSpecApprovalSummary(args: BuildSpecApprovalSummaryArgs): {
  web: string
  im: string
} {
  const { skillOutput, specMdContent, round, acDiff, feedbackMd, budgetExtended, aiReviewHistory } = args

  // === 降级路径：拿不到结构化输出时返回 spec.md 原文 ===
  if (!skillOutput) {
    const fallbackIm = `🤖 ${SpecSummaryI18n.TITLE} · 第 ${round} 轮（无结构化数据，请见 Web 端）`
    return { web: specMdContent || '', im: truncateImSummary(fallbackIm, IM_MAX_CHARS) }
  }

  const hint = computeHeuristicHint({ skillOutput, round, budgetExtended })

  // ===== Web 摘要 =====
  const lines: string[] = []
  lines.push(`## 📋 ${SpecSummaryI18n.TITLE} · 第 ${round} 轮`)

  // 1. 本次评估
  const evalParts: string[] = []
  if (skillOutput.confidenceLevel) {
    const conf = skillOutput.confidenceLevel
    const icon = conf === 'low' ? '🔴' : conf === 'medium' ? '🟡' : '🟢'
    const text = `${SpecSummaryI18n.CONFIDENCE_PREFIX} ${conf}`
    evalParts.push(conf === 'low' ? `${icon} **${text}**` : `${icon} ${text}`)
  }
  const risks = skillOutput.risks ?? []
  if (risks.length > 0) {
    const highCount = risks.filter((r) => r.severity === 'high').length
    const medCount = risks.filter((r) => r.severity === 'medium').length
    if (highCount > 0) evalParts.push(`🔴 ${highCount} high risk`)
    else if (medCount > 0) evalParts.push(`🟡 ${medCount} medium risk`)
    else evalParts.push('全 low risk')
  }
  if (evalParts.length > 0) {
    lines.push(`\n> 💡 **${SpecSummaryI18n.SECTION_EVAL}**：${evalParts.join(' · ')}`)
  }
  if (hint) lines.push(`> **建议**：${hint}`)

  // 2. 需要 review 的点
  const reviewHints = skillOutput.reviewHints ?? []
  lines.push(`\n### ⚠️ ${SpecSummaryI18n.SECTION_REVIEW_HINTS}`)
  if (reviewHints.length === 0) {
    lines.push(SpecSummaryI18n.EMPTY_HINTS)
  } else {
    const sorted = [...reviewHints].sort((a, b) => severityOrder(a.severity) - severityOrder(b.severity))
    const display = sorted.slice(0, REVIEW_HINTS_MAX_DISPLAY)
    display.forEach((h, i) => {
      lines.push(`${i + 1}. ${riskIcon(h.severity)} **${h.point}**`)
      lines.push(`   ${h.reason}`)
    })
    if (sorted.length > REVIEW_HINTS_MAX_DISPLAY) {
      lines.push(`\n_另有 ${sorted.length - REVIEW_HINTS_MAX_DISPLAY} 条详见折叠区_`)
    }
  }

  // 3. LLM 替你做的决定（assumption clarifications 表格）
  const allClarifs = skillOutput.clarifications ?? []
  const assumptions = allClarifs.filter((c) => c.kind === 'assumption')
  if (assumptions.length > 0) {
    lines.push(`\n### 📝 ${SpecSummaryI18n.SECTION_ASSUMPTIONS}（${assumptions.length} 条）`)
    lines.push('| 主题 | 默认决定 | 反对条件 |')
    lines.push('|---|---|---|')
    const display = assumptions.slice(0, ASSUMPTIONS_MAX_DISPLAY)
    display.forEach((a) => {
      const userMay = a.userMayDisagreeIf ?? '—'
      lines.push(`| ${escapeMd(a.q)} | ${escapeMd(a.a)} | ${escapeMd(userMay)} |`)
    })
    if (assumptions.length > ASSUMPTIONS_MAX_DISPLAY) {
      lines.push(`\n_另有 ${assumptions.length - ASSUMPTIONS_MAX_DISPLAY} 条详见折叠区_`)
    }
  }

  // 4. 范围
  const acN = skillOutput.acceptanceCriteria?.length ?? 0
  const e2eList = skillOutput.e2eScenarios ?? []
  const happyN = e2eList.filter((s) => s.kind === 'happy').length
  const negN = e2eList.filter((s) => s.kind === 'negative').length
  const refsN = skillOutput.references?.length ?? 0
  lines.push(
    `\n### 📊 ${SpecSummaryI18n.SECTION_SCOPE}\n${acN} AC · ${e2eList.length} e2e (${happyN}✓${negN}✗) · 涉及 ${refsN} 个 file:line 锚点`,
  )

  // 5. Round 2+ 双栏：上轮反馈 ↔ 本轮 acDiff
  if (round >= 2) {
    const parsedFeedback = feedbackMd ? parseFeedbackForSummary(feedbackMd) : { rejectReasons: [], reviewerNotes: [] }
    const acDiffNonEmpty =
      acDiff &&
      ((acDiff.added?.length ?? 0) + (acDiff.removed?.length ?? 0) + (acDiff.changed?.length ?? 0) > 0)

    if (parsedFeedback.rejectReasons.length > 0 || parsedFeedback.reviewerNotes.length > 0 || acDiffNonEmpty) {
      lines.push(`\n### 🔄 Round ${round} ${SpecSummaryI18n.SECTION_ROUND_DIFF}（${SpecSummaryI18n.TWO_COLUMN_NOTE}）`)
      lines.push('| 上轮反馈（你原话） | 本轮 AC 变化 |')
      lines.push('|---|---|')
      const left: string[] = []
      parsedFeedback.rejectReasons.forEach((r) => left.push(`📌 ${escapeMd(r)}`))
      parsedFeedback.reviewerNotes.forEach((n) => left.push(`💬 ${escapeMd(n)}`))
      const right: string[] = []
      if (acDiff?.added) acDiff.added.forEach((a) => right.push(`➕ ${a.id}: ${escapeMd(a.text.slice(0, 60))}`))
      if (acDiff?.removed) acDiff.removed.forEach((id) => right.push(`❌ ${id}`))
      if (acDiff?.changed) acDiff.changed.forEach((c) => right.push(`✏️ ${c.id}: ${escapeMd(c.newText.slice(0, 60))}`))
      const rows = Math.max(left.length, right.length, 1)
      for (let i = 0; i < rows; i++) {
        lines.push(`| ${left[i] ?? ''} | ${right[i] ?? ''} |`)
      }
    }
  }

  // AI 历次 review notes（spec_ai_review 耗尽轮次升级人审时显示）
  if (aiReviewHistory && aiReviewHistory.rounds > 0 && aiReviewHistory.notes.length > 0) {
    lines.push('')
    lines.push(`### AI 历次 review notes (round ${aiReviewHistory.rounds})`)
    for (const n of aiReviewHistory.notes) {
      const tag = n.severity === 'error' ? '🔴' : '🟡'
      lines.push(`- ${tag} ${n.msg}${n.file ? ` (${n.file})` : ''}`)
    }
  }

  // ===== 折叠区 =====
  lines.push('\n---\n')

  // AC 列表
  if (acN > 0) {
    lines.push(`<details><summary>📋 ${SpecSummaryI18n.DETAILS_AC} (${acN} 条)</summary>\n`)
    skillOutput.acceptanceCriteria.forEach((ac) => {
      lines.push(`- **${ac.id}**: ${ac.text}`)
    })
    lines.push('\n</details>\n')
  }

  // 涉及代码 file:line
  if (refsN > 0) {
    lines.push(`<details><summary>📍 ${SpecSummaryI18n.DETAILS_REFS} (${refsN} 处)</summary>\n`)
    skillOutput.references!.forEach((r) => {
      const loc = r.line !== undefined ? `${r.file}:${r.line}` : r.file
      lines.push(`- \`${loc}\` — ${r.purpose}`)
    })
    lines.push('\n</details>\n')
  }

  // 完整澄清问题（含 fact 在内的全部）
  if (allClarifs.length > 0) {
    lines.push(`<details><summary>❓ ${SpecSummaryI18n.DETAILS_CLARIFS} (${allClarifs.length} 条)</summary>\n`)
    allClarifs.forEach((c, i) => {
      const kindTag = c.kind ? `[${c.kind}] ` : ''
      lines.push(`${i + 1}. **${kindTag}Q**: ${c.q}`)
      lines.push(`   **A**: ${c.a}`)
      if (c.userMayDisagreeIf) lines.push(`   _反对条件_: ${c.userMayDisagreeIf}`)
    })
    lines.push('\n</details>\n')
  }

  // 完整 spec.md（>50KB 默认收起防 ReactMarkdown 性能差）
  if (specMdContent) {
    const isLarge = specMdContent.length > SPEC_MD_FOLD_THRESHOLD
    const openAttr = isLarge ? '' : ' open'
    lines.push(`<details${openAttr}><summary>📄 ${SpecSummaryI18n.DETAILS_FULL_SPEC}</summary>\n\n${specMdContent}\n\n</details>`)
  }

  const web = lines.join('\n')

  // ===== IM 摘要（≤ 250 字符）=====
  const imLines: string[] = []
  imLines.push(`🤖 ${SpecSummaryI18n.TITLE} · 第 ${round} 轮`)
  if (skillOutput.confidenceLevel === 'low') {
    imLines.push('🔴 低自信，需细审')
  }
  if (hint) imLines.push(`💡 ${hint}`)

  // top reviewHint 的 point（含 severity icon）
  if (reviewHints.length > 0) {
    const top = [...reviewHints].sort((a, b) => severityOrder(a.severity) - severityOrder(b.severity))[0]
    imLines.push(`⚠️ ${riskIcon(top.severity)} ${top.point.slice(0, 60)}`)
  }

  // assumptions 计数提示
  if (assumptions.length > 0) {
    imLines.push(`📝 ${assumptions.length} 条假设需确认`)
  }

  // 范围
  const riskN = risks.length
  imLines.push(`📊 ${acN} AC · ${e2eList.length} e2e · ${riskN} risks`)

  const im = truncateImSummary(imLines.join('\n'), IM_MAX_CHARS)

  return { web, im }
}

/** 转义 markdown 表格里的 | 符号 */
function escapeMd(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ')
}
