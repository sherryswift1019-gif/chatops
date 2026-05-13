import { describe, it, expect } from 'vitest'
import { buildSpecApprovalSummary } from '../../pipeline/approval-summary/spec.js'
import type { SpecAuthorOutput } from '../../quick-impl/role-output-schemas.js'

// Minimal valid SpecAuthorOutput fixture
const minSkillOut: SpecAuthorOutput = {
  schemaVersion: 'v2',
  summary: '一个测试 spec',
  decision: 'pass',
  notes: [],
  confidenceLevel: 'high',
  reviewHints: [],
  noGos: [],
  evidence: { standardsConsulted: [], selfCheck: [] },
  acceptanceCriteria: [],
  e2eScenarios: [],
  openQuestions: [],
  risks: [],
  references: [],
  clarifications: [],
} as any

describe('buildSpecApprovalSummary with AI review history', () => {
  it('includes AI review notes section when aiReviewHistory has rounds > 0', () => {
    const summary = buildSpecApprovalSummary({
      skillOutput: minSkillOut,
      specMdContent: '# spec',
      round: 1,
      aiReviewHistory: {
        rounds: 3,
        notes: [
          { severity: 'error', msg: 'AC-3 主观词' },
          { severity: 'error', msg: 'reviewHints 空' },
        ],
      },
    })
    expect(summary.web).toContain('AI 历次 review notes')
    expect(summary.web).toContain('AC-3 主观词')
    expect(summary.web).toContain('round 3')
  })

  it('omits AI history section when aiReviewHistory undefined', () => {
    const summary = buildSpecApprovalSummary({
      skillOutput: minSkillOut, specMdContent: '#', round: 1,
    })
    expect(summary.web).not.toContain('AI 历次 review notes')
  })

  it('omits AI history section when rounds=0', () => {
    const summary = buildSpecApprovalSummary({
      skillOutput: minSkillOut, specMdContent: '#', round: 1,
      aiReviewHistory: { rounds: 0, notes: [] },
    })
    expect(summary.web).not.toContain('AI 历次 review notes')
  })
})
