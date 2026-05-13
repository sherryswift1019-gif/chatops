import { registerNodeType } from './registry.js'
import { z } from 'zod'
import type { BrainstormWaiter } from '../../db/repositories/brainstorm-waiters.js'

registerNodeType({
  key: 'llm_brainstorm',
  async execute() {
    throw new Error(
      'llm_brainstorm must be invoked via graph-builder (buildLlmBrainstormNode). See src/pipeline/graph-builder.ts.',
    )
  },
})

export type BrainstormTurn = {
  round: number
  question: string
  answer: string
  source: 'web' | 'im'
  answeredAt: string
}

export type BrainstormState = {
  round: number
  history: BrainstormTurn[]
  enrichedInput: Record<string, unknown>
  readyForSpec: boolean
  earlyDone: boolean
  partial: boolean
  failedQualityRounds: number
}

export function initBrainstormState(): BrainstormState {
  return {
    round: 1,
    history: [],
    enrichedInput: {},
    readyForSpec: false,
    earlyDone: false,
    partial: false,
    failedQualityRounds: 0,
  }
}

export type BrainstormOption = { id: string; label: string }

const SECTION_HEADERS = {
  context: /##\s*已查证的现状/,
  decision: /##\s*这一轮要决定/,
  options: /##\s*选项[（(]带我的推荐[）)]/,
  defaults: /##\s*我替你做的默认/,
  reply: /##\s*你怎么回[？?]/,
} as const

type SectionKey = keyof typeof SECTION_HEADERS

export type ParseResult = {
  valid: boolean
  sections: Record<SectionKey, string>
  missingSections: string[]
  violations: string[]
  options: BrainstormOption[]
}

/**
 * 从 "## 选项（带我的推荐）" 段落解析 ABCD 选项行。
 * 兼容多种 LLM 输出格式：
 *   **A.** 标签 / **A：** 标签 / **A** 标签 / A. 标签 / - **A.** 标签
 *   行尾可能跟"（推荐）"等说明，作为 label 一部分保留。
 */
export function parseOptionsFromMarkdown(optionsSection: string): BrainstormOption[] {
  if (!optionsSection) return []
  const lines = optionsSection.split('\n')
  const opts: BrainstormOption[] = []
  const seen = new Set<string>()
  // 匹配行首（允许 `- ` / `* ` 列表标记）后跟可选 `**` 包围的 A-Z 字母 + 可选标点 + 标签文字
  const re = /^\s*(?:[-*]\s*)?(?:\*\*)?\s*([A-Z])\s*[\.\:：、)]?\s*(?:\*\*)?\s*(.+?)\s*$/
  for (const raw of lines) {
    const m = raw.match(re)
    if (!m) continue
    const id = m[1]
    const label = m[2].replace(/^\*+|\*+$/g, '').trim()
    if (!label || label.length < 1) continue
    if (seen.has(id)) continue
    seen.add(id)
    opts.push({ id, label })
  }
  return opts
}

export function parseFiveSectionMarkdown(
  md: string,
  opts?: { round?: number },
): ParseResult {
  const sections: Record<string, string> = {}
  const missingSections: string[] = []
  const violations: string[] = []

  const parts = md.split(/(?=##\s)/)
  for (const [key, re] of Object.entries(SECTION_HEADERS)) {
    const part = parts.find(p => re.test(p))
    if (!part) {
      missingSections.push(key)
      sections[key] = ''
      continue
    }
    sections[key] = part.replace(re, '').trim()
  }

  if (sections.options !== undefined && !/\*\*[A-Z]\b|\b[A-Z]\.\s|\b[A-Z][\.：:]\*\*/.test(sections.options)) {
    violations.push('no_options_listed')
  }

  if (opts?.round && opts.round >= 2) {
    const hasHistoryRef = /上一轮|前轮|round\s*\d|之前|上次/i.test(sections.context ?? '')
    if (!hasHistoryRef) {
      violations.push('round2_missing_history_reference')
    }
  }

  const options = parseOptionsFromMarkdown(sections.options ?? '')

  return {
    valid: missingSections.length === 0 && violations.length === 0,
    sections: sections as Record<SectionKey, string>,
    missingSections,
    violations,
    options,
  }
}

const BRAINSTORM_MAX_ROUNDS = 5

export type BrainstormLlmOutput = {
  decision: 'ask' | 'ready' | 'fail'
  round: number
  question?: string
  enrichedInputDelta?: Record<string, unknown>
}

const BrainstormLlmOutputSchema = z.object({
  decision: z.enum(['ask', 'ready', 'fail']),
  round: z.number().int().min(1).optional().default(1),
  question: z.string().optional(),
  enrichedInputDelta: z.record(z.string(), z.unknown()).optional(),
})

/**
 * brainstorm-host LLM 输出 zod 校验。
 * 输入是 raw string（可能含 markdown code fence 或多余 text），尝试提取 JSON 后解析。
 * 失败抛 BrainstormLlmParseError，caller catch 处理 partial fallback。
 */
export class BrainstormLlmParseError extends Error {
  constructor(public readonly raw: string, public readonly reason: string) {
    super(`brainstorm LLM output parse failed: ${reason}`)
    this.name = 'BrainstormLlmParseError'
  }
}

export function parseBrainstormLlmJson(raw: string): BrainstormLlmOutput {
  if (!raw || typeof raw !== 'string') {
    throw new BrainstormLlmParseError(String(raw), 'empty_output')
  }
  // 优先匹配 markdown code fence 内的 JSON
  let jsonText = raw.trim()
  const fence = jsonText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
  if (fence) {
    jsonText = fence[1].trim()
  } else {
    // 退回找首个 { 到末尾 }（贪婪）
    const start = jsonText.indexOf('{')
    const end = jsonText.lastIndexOf('}')
    if (start >= 0 && end > start) {
      jsonText = jsonText.slice(start, end + 1)
    }
  }
  let obj: unknown
  try {
    obj = JSON.parse(jsonText)
  } catch (err) {
    throw new BrainstormLlmParseError(raw, `json_syntax: ${(err as Error).message}`)
  }
  const result = BrainstormLlmOutputSchema.safeParse(obj)
  if (!result.success) {
    throw new BrainstormLlmParseError(raw, `schema: ${result.error.message}`)
  }
  return result.data
}

export type AdvanceArgs = {
  llmOutput: BrainstormLlmOutput
  userAnswer: { chosenOption?: string; freeText?: string } | null
  source: 'web' | 'im'
}

export function advanceBrainstormState(state: BrainstormState, args: AdvanceArgs): BrainstormState {
  const next: BrainstormState = {
    ...state,
    history: [...state.history],
    enrichedInput: { ...state.enrichedInput, ...(args.llmOutput.enrichedInputDelta ?? {}) },
  }

  // /done detection: highest priority, checked before all decision branches
  const userText = args.userAnswer?.freeText?.trim() ?? ''
  if (userText && /^\/?(done|stop|结束|够了)$/i.test(userText)) {
    next.earlyDone = true
    next.readyForSpec = true
    return next
  }

  if (args.llmOutput.decision === 'ready') {
    next.readyForSpec = true
    return next
  }
  if (args.llmOutput.decision === 'fail') {
    next.readyForSpec = true
    next.partial = true
    return next
  }

  // decision === 'ask': validate markdown
  if (args.llmOutput.question) {
    const parsed = parseFiveSectionMarkdown(args.llmOutput.question, { round: state.round })
    if (!parsed.valid) {
      next.failedQualityRounds += 1
      // consecutive 2x quality fail → force close (priority: quality fail > round cap)
      if (next.failedQualityRounds >= 2) {
        next.readyForSpec = true
        next.partial = true
      }
      return next  // do not advance round
    }
  }

  // user answer present → archive turn, advance round
  if (args.userAnswer) {
    next.history.push({
      round: state.round,
      question: args.llmOutput.question ?? '',
      answer: args.userAnswer.freeText ?? args.userAnswer.chosenOption ?? '',
      source: args.source,
      answeredAt: new Date().toISOString(),
    })
    next.round = state.round + 1
  }

  if (next.round > BRAINSTORM_MAX_ROUNDS) {
    next.readyForSpec = true
    next.partial = true
  }

  return next
}

/**
 * 从 answered waiter 行重建 BrainstormState 到"该轮结束后"的形态。
 * waiter 行存的 enriched_input/history/failedQualityRounds 是该轮入口的快照；
 * 加上 chosen_option/free_text 调 advanceBrainstormState 推进。
 *
 * 注：本函数假定 waiter 的 question_md 已通过 parseFiveSectionMarkdown 校验（节点写库前确保），
 * 因此重建时不会再走"quality fail"分支。
 */
export function rebuildAfterWaiter(
  bsBefore: BrainstormState,
  waiter: BrainstormWaiter,
): BrainstormState {
  // 用 waiter 行快照重置 bs（替换而非合并，保证 replay 幂等）
  const bs: BrainstormState = {
    round: waiter.round,
    history: [...waiter.history] as BrainstormTurn[],
    enrichedInput: { ...waiter.enrichedInput },
    readyForSpec: waiter.readyForSpec,
    earlyDone: bsBefore.earlyDone,
    partial: bsBefore.partial,
    failedQualityRounds: waiter.failedQualityRounds,
  }

  if (waiter.status !== 'answered') {
    return bs  // pending / expired: 不推进
  }

  const llmOutput: BrainstormLlmOutput = {
    decision: 'ask',
    round: waiter.round,
    question: waiter.questionMd,
  }
  const userAnswer = {
    chosenOption: waiter.chosenOption ?? undefined,
    freeText: waiter.freeText ?? undefined,
  }
  return advanceBrainstormState(bs, {
    llmOutput,
    userAnswer,
    source: waiter.source ?? 'web',
  })
}

