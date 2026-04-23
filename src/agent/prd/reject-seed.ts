import type {
  PrdDocument,
  PrdReviewFinding,
  PrdReviewHistoryEntry,
} from '../../db/repositories/prd-documents.js'

export interface RejectContext {
  reason: string
  blockers: PrdReviewFinding[]
}

/**
 * 从 PRD 的 review_history 里提取"最近一次被人工驳回"的上下文。
 * - reason：末条 entry 的 recommendation.reason（若 action !== 'reject' 则返回 null）
 * - blockers：manual reject 本身 findings=[]，回溯到倒数第二条的 blocker 级 findings
 *
 * 无 reject 记录 / 无 history 时返回 null。
 */
export function extractRejectContext(prd: Pick<PrdDocument, 'reviewHistory'>): RejectContext | null {
  const history = prd.reviewHistory ?? []
  if (history.length === 0) return null

  const last = history[history.length - 1]
  const action = last?.result?.recommendation?.action
  if (action !== 'reject') return null

  const reason = last.result.recommendation?.reason ?? '（无备注）'

  // 倒序找离 reject 最近、findings 非空的一条（通常是上一轮 review_blocked 的 AI 自审记录）
  let blockers: PrdReviewFinding[] = []
  for (let i = history.length - 2; i >= 0; i--) {
    const entry: PrdReviewHistoryEntry | undefined = history[i]
    const findings = entry?.result?.findings ?? []
    if (findings.length === 0) continue
    blockers = findings.filter((f) => f.severity === 'blocker')
    if (blockers.length === 0) blockers = findings
    break
  }

  return { reason, blockers }
}

/**
 * 生成给 PM 看的 chat 起始 seed 消息（Markdown 文本）。
 * 调用方用它写一条 role='assistant' 消息到 prd_chat_messages。
 */
export function buildRejectSeedText(prd: PrdDocument): string | null {
  const ctx = extractRejectContext(prd)
  if (!ctx) return null

  const lines: string[] = [
    `⚠️ 本次对话基于 PRD #${prd.id}《${prd.title}》（v${prd.version}）的最近一次驳回意见继续。`,
    '',
    `**驳回原因**：${ctx.reason}`,
  ]

  if (ctx.blockers.length > 0) {
    lines.push('', '**上一轮自审 blockers**（如还没修可以先讨论这些）：')
    for (const b of ctx.blockers.slice(0, 10)) {
      const dim = b.dimension ? `[${b.dimension}/${b.severity}] ` : ''
      const loc = b.location ? `（${b.location}）` : ''
      lines.push(`- ${dim}${b.description}${loc}`)
    }
    if (ctx.blockers.length > 10) {
      lines.push(`- …（共 ${ctx.blockers.length} 条，详情见 PRD 详情页）`)
    }
  }

  lines.push('', '我可以帮你梳理修改方向，告诉我想先聊哪一条。')
  return lines.join('\n')
}

/**
 * 生成给 Claude 看的系统提示追加段（仅当 PRD 处于 drafting 且最近一次 review 是 reject 时）。
 * 并入 buildPrdContext 的尾部，让 Claude 下一轮能看到驳回上下文。
 */
export function buildRejectSystemPromptAppendix(
  prd: Pick<PrdDocument, 'status' | 'reviewHistory'>
): string | null {
  if (prd.status !== 'drafting') return null
  const ctx = extractRejectContext(prd)
  if (!ctx) return null

  const lines: string[] = [
    '',
    '## 最近一次驳回',
    `原因：${ctx.reason}`,
  ]
  if (ctx.blockers.length > 0) {
    lines.push('上一轮 blockers：')
    for (const b of ctx.blockers.slice(0, 10)) {
      const dim = b.dimension ? `[${b.dimension}] ` : ''
      lines.push(`- ${dim}${b.description}`)
    }
  }
  lines.push('请根据这些意见继续帮用户修改 PRD，不要当新对话重开。')
  return lines.join('\n')
}
