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

  if (sections.options !== undefined && !/\*\*[A-Z]\.\s/.test(sections.options)) {
    violations.push('no_options_listed')
  }

  if (opts?.round && opts.round >= 2) {
    const hasHistoryRef = /上一轮|前轮|round\s*\d|之前|上次/i.test(sections.context ?? '')
    if (!hasHistoryRef) {
      violations.push('round2_missing_history_reference')
    }
  }

  return {
    valid: missingSections.length === 0 && violations.length === 0,
    sections: sections as Record<SectionKey, string>,
    missingSections,
    violations,
  }
}

const BRAINSTORM_MAX_ROUNDS = 5

export type BrainstormLlmOutput = {
  decision: 'ask' | 'ready' | 'fail'
  round: number
  question?: string
  enrichedInputDelta?: Record<string, unknown>
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
      return next  // do not advance round; T22 handles consecutive 2x fail → readyForSpec
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
