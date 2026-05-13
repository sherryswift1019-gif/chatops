import { describe, it, expect } from 'vitest'
import { SpecReviewOutputSchema } from '../../pipeline/node-types/llm-review.js'

describe('SpecReviewOutputSchema round 2+ itemized tracking', () => {
  it('round 1 does not require resolvedFromPrevious', () => {
    const out = {
      round: 1, decision: 'fail',
      notes: [{ severity: 'error', msg: 'AC-3 主观词' }],
      newIssues: [{ severity: 'error', msg: 'AC-3 主观词' }],
      decisionBasis: '第一轮 review',
    }
    expect(() => SpecReviewOutputSchema.parse(out)).not.toThrow()
  })

  it('round 2+ requires resolvedFromPrevious array', () => {
    const out = {
      round: 2, decision: 'fail',
      notes: [],
      newIssues: [],
      decisionBasis: '...',
    }
    expect(() => SpecReviewOutputSchema.parse(out)).toThrow(/resolvedFromPrevious/)
  })

  it('round 2+ accepts resolvedFromPrevious with status enum', () => {
    const out = {
      round: 2, decision: 'pass',
      notes: [],
      newIssues: [],
      decisionBasis: '上轮已 resolved',
      resolvedFromPrevious: [
        { previousNote: 'AC-3 主观词', status: 'resolved', evidence: '改为 status=201 断言' },
      ],
    }
    expect(() => SpecReviewOutputSchema.parse(out)).not.toThrow()
  })

  it('round 2+ rejects resolvedFromPrevious with invalid status', () => {
    const out = {
      round: 2, decision: 'pass',
      notes: [], newIssues: [], decisionBasis: '...',
      resolvedFromPrevious: [
        { previousNote: 'x', status: 'maybe', evidence: 'y' },
      ],
    }
    expect(() => SpecReviewOutputSchema.parse(out)).toThrow()
  })

  it.skip('integration: buildLlmReviewNode injects drift warn when newIssues > resolved', () => {
    // Integration-level, requires full graph mock; defer to T30 E2E
    expect(true).toBe(true)
  })
})
