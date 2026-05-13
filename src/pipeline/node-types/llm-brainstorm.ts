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
