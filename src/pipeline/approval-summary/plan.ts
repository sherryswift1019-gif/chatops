/**
 * plan_human_escalation 节点的审批摘要拼装。
 *
 * 输入：plan-decomposer 结构化输出 + plan-reviewer 最后一轮 notes + reviewHistory + plan.md 全文
 * 输出：{ web, im }
 *   - web: markdown，5 段 + 折叠区
 *   - im:  ≤ 250 字符纯文本，钉钉/飞书卡片 body
 *
 * 5 段 web 摘要（与 prd-plan-human-escalation-decision.md §5 屏 1 对齐）：
 *   1. AI 拒绝原因（顶部，按 severity 排前 5；为人审 Q1 判断 nitpick vs blocker 提供依据）
 *   2. 当前 plan 概览（任务数 / 总估算 LOC / AC 覆盖 / migrations）
 *   3. 任务清单（id / type / title / coverAC / estimatedLoc 简表）
 *   4. 风险 & 取舍（plan.decisions[] + spec.risks[high]）
 *   5. Round 2+ 才有：上轮反馈
 *
 * 折叠区 <details>：完整 reviewHistory / spec AC / plan.md 原文
 *
 * IM 摘要：4 行精简（标题 + 顶部 AI note + 范围 + hint）。
 */
import type {
  PlanDecomposerOutputV3,
  PlanReviewerOutput,
  SpecAuthorOutput,
} from '../../quick-impl/role-output-schemas.js'
import { riskIcon, truncateImSummary } from './shared.js'
import { severityOrder } from './i18n.js'

const PLAN_MD_FOLD_THRESHOLD = 50_000
const NOTES_TOP_DISPLAY = 5
const TASKS_TOP_DISPLAY = 8
const IM_MAX_CHARS = 250

interface ReviewerNote {
  severity?: string
  msg: string
  file?: string
}

interface ReviewerOutputLike {
  summary?: string
  decision?: string
  notes?: ReviewerNote[]
  specCoverage?: Array<{ ac: string; covered: boolean; missingReason?: string }>
  planQualityIssues?: Array<{ checkId?: string; severity: string; message: string; taskId?: string }>
}

export interface BuildPlanApprovalSummaryArgs {
  /** 当前 plan-decomposer 输出（stage 3 重跑 or stage 2 stepOutputs.skillOutput）*/
  planSkillOutput: PlanDecomposerOutputV3 | null
  /** 上一阶段 AI reviewer 最后一轮输出（含 notes / specCoverage） */
  lastReview: ReviewerOutputLike | PlanReviewerOutput | null
  /** 上一阶段全部轮次 reviewer 输出（按 round 升序） */
  reviewHistory?: Array<{ round: number; output: Record<string, unknown> }>
  /** plan.md 全文（折叠区底部） */
  planMdContent: string
  /** spec-author 输出，用于 AC 总数对比与风险展示 */
  specOutput?: SpecAuthorOutput | null
  /** 当前 round（≥ 1） */
  round: number
  /** 上一阶段被 AI 拒绝的轮数（决定标题 hint） */
  aiRejectRounds: number
}

export function buildPlanApprovalSummary(args: BuildPlanApprovalSummaryArgs): {
  web: string
  im: string
} {
  const {
    planSkillOutput,
    lastReview,
    reviewHistory = [],
    planMdContent,
    specOutput,
    round,
    aiRejectRounds,
  } = args

  // 降级：拿不到结构化数据 → 退回 plan.md 原文（旧行为兼容）
  if (!planSkillOutput && !lastReview) {
    const fallbackIm = `🤖 Plan 评审 · 第 ${round} 轮（无结构化数据，请见 Web 端）`
    return { web: planMdContent || '', im: truncateImSummary(fallbackIm, IM_MAX_CHARS) }
  }

  const review = (lastReview ?? null) as ReviewerOutputLike | null
  const notes = review?.notes ?? []
  const sortedNotes = [...notes].sort(
    (a, b) => severityOrder(a.severity ?? 'low') - severityOrder(b.severity ?? 'low'),
  )
  const errorCount = notes.filter((n) => n.severity === 'error').length
  const warnCount = notes.filter((n) => n.severity === 'warn').length

  const tasks = planSkillOutput?.tasks ?? []
  const totalLoc = tasks.reduce((sum, t) => sum + (t.estimatedLoc ?? 0), 0)
  const migrationsN = planSkillOutput?.migrations?.length ?? 0
  const coveredAcSet = new Set<string>()
  tasks.forEach((t) => t.coverAC?.forEach((ac) => coveredAcSet.add(ac)))
  const acTotal = specOutput?.acceptanceCriteria?.length ?? coveredAcSet.size
  const coveredCount = coveredAcSet.size
  const uncoveredAcs = (specOutput?.acceptanceCriteria ?? [])
    .map((ac) => ac.id)
    .filter((id) => !coveredAcSet.has(id))

  const hint = computePlanHint({
    errorCount,
    uncoveredCount: uncoveredAcs.length,
    aiRejectRounds,
  })

  // ===== Web 摘要 =====
  const lines: string[] = []
  lines.push(`## 📋 Plan 评审 · 第 ${round} 轮（AI 已拒绝 ${aiRejectRounds} 轮）`)
  if (hint) lines.push(`\n> 💡 **建议**：${hint}`)

  // 1. AI 拒绝原因（最关键段）
  lines.push(`\n### ⛔ AI Reviewer 拒绝原因（${errorCount} error · ${warnCount} warn）`)
  if (sortedNotes.length === 0) {
    lines.push('_（AI reviewer 未返回 notes，参考折叠区 reviewHistory）_')
  } else {
    const display = sortedNotes.slice(0, NOTES_TOP_DISPLAY)
    display.forEach((n, i) => {
      const sev = (n.severity ?? 'warn') as 'high' | 'medium' | 'low' | 'error' | 'warn'
      const icon = sev === 'error' ? '🔴' : sev === 'warn' ? '🟡' : riskIcon(sev as 'high' | 'medium' | 'low')
      const fileTag = n.file ? ` · \`${n.file}\`` : ''
      lines.push(`${i + 1}. ${icon} ${escapeMd(n.msg)}${fileTag}`)
    })
    if (sortedNotes.length > NOTES_TOP_DISPLAY) {
      lines.push(`\n_另有 ${sortedNotes.length - NOTES_TOP_DISPLAY} 条详见折叠区 reviewHistory_`)
    }
  }

  // 2. 当前 plan 概览
  const acPart = acTotal > 0 ? `${coveredCount}/${acTotal} AC` : `${coveredCount} AC`
  const uncoveredHint = uncoveredAcs.length > 0 ? ` · ❗ 未覆盖：${uncoveredAcs.join(', ')}` : ''
  const migrationPart = migrationsN > 0 ? ` · ${migrationsN} migration` : ''
  lines.push(
    `\n### 📊 当前 plan 概览\n${tasks.length} 个任务 · 估 ${totalLoc} LOC · ${acPart}${uncoveredHint}${migrationPart}`,
  )

  // 3. 任务清单
  if (tasks.length > 0) {
    lines.push('\n### 📦 任务清单')
    lines.push('| ID | 类型 | 标题 | 覆盖 AC | 估 LOC |')
    lines.push('|---|---|---|---|---|')
    const display = tasks.slice(0, TASKS_TOP_DISPLAY)
    display.forEach((t) => {
      lines.push(
        `| ${t.id} | ${t.type} | ${escapeMd(t.title.slice(0, 50))} | ${t.coverAC?.join(', ') ?? '—'} | ${t.estimatedLoc ?? '—'} |`,
      )
    })
    if (tasks.length > TASKS_TOP_DISPLAY) {
      lines.push(`\n_另有 ${tasks.length - TASKS_TOP_DISPLAY} 个任务详见折叠区 plan.md_`)
    }
  }

  // 4. 风险 & 取舍
  const decisions = planSkillOutput?.decisions ?? []
  const highRisks = (specOutput?.risks ?? []).filter((r) => r.severity === 'high')
  if (decisions.length > 0 || highRisks.length > 0) {
    lines.push('\n### ⚖️ 风险 & 取舍')
    highRisks.slice(0, 3).forEach((r) => {
      lines.push(`- 🔴 ${escapeMd(r.desc)}`)
    })
    decisions.slice(0, 3).forEach((d) => {
      lines.push(
        `- 📌 ${escapeMd(d.choice)} _（拒绝：${escapeMd(d.alternatives?.join(' / ') ?? '—')}, 理由：${escapeMd(d.rejectedReason ?? '—')}）_`,
      )
    })
  }

  // 5. Round 2+ 上轮反馈（仅 stage 3 自身已 round 2+ 时）
  if (round >= 2 && reviewHistory.length > 1) {
    const prev = reviewHistory[reviewHistory.length - 2]
    const prevNotes = ((prev?.output as ReviewerOutputLike)?.notes ?? []).slice(0, 3)
    if (prevNotes.length > 0) {
      lines.push(`\n### 🔄 上一轮 AI reviewer 反馈（round ${prev.round}，参考）`)
      prevNotes.forEach((n) => {
        const sev = n.severity ?? 'warn'
        const icon = sev === 'error' ? '🔴' : sev === 'warn' ? '🟡' : '⚪'
        lines.push(`- ${icon} ${escapeMd(n.msg)}`)
      })
    }
  }

  // ===== 折叠区 =====
  lines.push('\n---\n')

  // reviewHistory 全部轮
  if (reviewHistory.length > 0) {
    lines.push(`<details><summary>📜 AI Review 全部轮次（${reviewHistory.length} 轮）</summary>\n`)
    reviewHistory.forEach((entry) => {
      const out = entry.output as ReviewerOutputLike
      lines.push(`\n**Round ${entry.round}** — ${escapeMd(out.summary ?? '(无 summary)')}`)
      const entryNotes = out.notes ?? []
      if (entryNotes.length > 0) {
        entryNotes.forEach((n) => {
          const sev = n.severity ?? 'warn'
          const icon = sev === 'error' ? '🔴' : sev === 'warn' ? '🟡' : '⚪'
          lines.push(`- ${icon} ${escapeMd(n.msg)}`)
        })
      }
    })
    lines.push('\n</details>\n')
  }

  // spec AC 列表
  const acList = specOutput?.acceptanceCriteria ?? []
  if (acList.length > 0) {
    lines.push(`<details><summary>📋 验收标准 (${acList.length} 条)</summary>\n`)
    acList.forEach((ac) => {
      const tag = coveredAcSet.has(ac.id) ? '✅' : '❌'
      lines.push(`- ${tag} **${ac.id}**: ${escapeMd(ac.text)}`)
    })
    lines.push('\n</details>\n')
  }

  // plan.md 全文
  if (planMdContent) {
    const isLarge = planMdContent.length > PLAN_MD_FOLD_THRESHOLD
    const openAttr = isLarge ? '' : ' open'
    lines.push(
      `<details${openAttr}><summary>📄 完整 plan.md</summary>\n\n${planMdContent}\n\n</details>`,
    )
  }

  const web = lines.join('\n')

  // ===== IM 摘要（≤ 250 字符）=====
  const imLines: string[] = []
  imLines.push(`🤖 Plan 评审 · 第 ${round} 轮（AI 拒 ${aiRejectRounds} 轮）`)
  if (hint) imLines.push(`💡 ${hint}`)
  if (sortedNotes.length > 0) {
    const top = sortedNotes[0]
    const icon = top.severity === 'error' ? '🔴' : top.severity === 'warn' ? '🟡' : '⚪'
    imLines.push(`⛔ ${icon} ${top.msg.slice(0, 60)}`)
  }
  imLines.push(`📊 ${tasks.length} 任务 · ${totalLoc} LOC · ${acPart}`)
  const im = truncateImSummary(imLines.join('\n'), IM_MAX_CHARS)

  return { web, im }
}

function computePlanHint(args: {
  errorCount: number
  uncoveredCount: number
  aiRejectRounds: number
}): string {
  const { errorCount, uncoveredCount, aiRejectRounds } = args
  if (uncoveredCount > 0) return `${uncoveredCount} 条 AC 未覆盖，建议拒绝重拆`
  if (errorCount === 0) return '仅 warn 级提示，建议视情况批准'
  if (errorCount >= 3) return `${errorCount} 条 error，建议拒绝`
  if (aiRejectRounds >= 2) return `AI 已拒 ${aiRejectRounds} 轮未收敛，请人工判断 nitpick vs blocker`
  return '建议先看清 error 后再判断'
}

function escapeMd(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ')
}
