/**
 * Phase 2: 4 个 role 输出 zod schema 校验测试。
 */
import { describe, expect, it } from 'vitest'
import {
  validateRoleOutput,
  SpecAuthorOutputSchema,
  PlanDecomposerOutputSchema,
  DevLoopOutputSchema,
  ReviewerOutputSchema,
} from '../../quick-impl/role-output-schemas.js'

const baseEvidence = {
  standardsConsulted: ['docs/standards/foo.md'],
  selfCheck: [{ item: 'check 1', passed: true }],
}

// =============================================================================
// spec-author
// =============================================================================

describe('SpecAuthorOutputSchema', () => {
  const validSpecOut = {
    summary: '已撰写需求规格',
    decision: 'pass' as const,
    notes: [],
    evidence: baseEvidence,
    acceptanceCriteria: [
      { id: 'AC-1', format: 'given-when-then' as const, text: 'Given X, When Y, Then Z' },
    ],
    openQuestions: [],
    risks: [{ desc: 'localStorage 配额', severity: 'medium' as const }],
    references: [{ file: 'web/src/login.tsx', line: 42, purpose: 'existing login' }],
    clarifications: [],
  }

  it('accepts valid output', () => {
    const r = SpecAuthorOutputSchema.safeParse(validSpecOut)
    expect(r.success).toBe(true)
  })

  it('rejects when acceptanceCriteria empty', () => {
    const r = SpecAuthorOutputSchema.safeParse({ ...validSpecOut, acceptanceCriteria: [] })
    expect(r.success).toBe(false)
  })

  it('rejects when risks empty (must have ≥1)', () => {
    const r = SpecAuthorOutputSchema.safeParse({ ...validSpecOut, risks: [] })
    expect(r.success).toBe(false)
  })

  it('rejects when references empty', () => {
    const r = SpecAuthorOutputSchema.safeParse({ ...validSpecOut, references: [] })
    expect(r.success).toBe(false)
  })

  it('rejects malformed AC id', () => {
    const r = SpecAuthorOutputSchema.safeParse({
      ...validSpecOut,
      acceptanceCriteria: [{ id: 'X1', format: 'given-when-then' as const, text: 'foo' }],
    })
    expect(r.success).toBe(false)
  })
})

// =============================================================================
// plan-decomposer
// =============================================================================

describe('PlanDecomposerOutputSchema', () => {
  const validPlanOut = {
    summary: '已拆解为 2 个任务',
    decision: 'pass' as const,
    notes: [],
    evidence: baseEvidence,
    tasks: [
      {
        id: 'T1', type: 'feature' as const, title: '加 Checkbox',
        files: ['web/src/login.tsx'], coverAC: ['AC-1'], dependsOn: [], estimatedLoc: 50,
      },
      {
        id: 'T2', type: 'test' as const, title: 'T1 测试',
        files: ['src/__tests__/unit/login.test.ts'], coverAC: ['AC-1'], dependsOn: ['T1'], estimatedLoc: 80,
      },
    ],
    migrations: [],
  }

  it('accepts valid plan with feature+test', () => {
    const r = PlanDecomposerOutputSchema.safeParse(validPlanOut)
    expect(r.success).toBe(true)
  })

  it('rejects feature task without corresponding test task', () => {
    const r = PlanDecomposerOutputSchema.safeParse({
      ...validPlanOut,
      tasks: [validPlanOut.tasks[0]], // 只有 feature，没 test
    })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.some((i) => i.message.includes('no corresponding test task'))).toBe(true)
    }
  })

  it('rejects unknown dependsOn', () => {
    const r = PlanDecomposerOutputSchema.safeParse({
      ...validPlanOut,
      tasks: [
        validPlanOut.tasks[0],
        { ...validPlanOut.tasks[1], dependsOn: ['T999'] },
      ],
    })
    expect(r.success).toBe(false)
  })

  it('rejects DAG cycle', () => {
    const r = PlanDecomposerOutputSchema.safeParse({
      ...validPlanOut,
      tasks: [
        { ...validPlanOut.tasks[0], dependsOn: ['T2'] },
        { ...validPlanOut.tasks[1], dependsOn: ['T1'] },
      ],
    })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.some((i) => i.message.includes('cycle'))).toBe(true)
    }
  })

  it('rejects malformed migration file name', () => {
    const r = PlanDecomposerOutputSchema.safeParse({
      ...validPlanOut,
      migrations: [{ file: 'not-a-schema.sql', rollbackPlan: '...' }],
    })
    expect(r.success).toBe(false)
  })
})

// =============================================================================
// dev-loop
// =============================================================================

describe('DevLoopOutputSchema', () => {
  const validDevOut = {
    summary: '已实现 2 个任务并 commit',
    decision: 'pass' as const,
    notes: [],
    evidence: baseEvidence,
    commits: [
      {
        taskId: 'T1',
        sha: 'abc1234',
        message: 'feat(qi-7): T1 添加 Checkbox',
        filesChanged: ['web/src/login.tsx'],
        tsc: 'pass' as const,
        vitest: { command: 'pnpm exec vitest --related --run web/src/login.tsx', passed: 5, failed: 0 },
      },
    ],
    skippedTasks: [],
    failedTasks: [],
  }

  it('accepts valid dev output', () => {
    const r = DevLoopOutputSchema.safeParse(validDevOut)
    expect(r.success).toBe(true)
  })

  it('rejects malformed commit message', () => {
    const r = DevLoopOutputSchema.safeParse({
      ...validDevOut,
      commits: [{ ...validDevOut.commits[0], message: 'random commit msg' }],
    })
    expect(r.success).toBe(false)
  })

  it('rejects malformed sha', () => {
    const r = DevLoopOutputSchema.safeParse({
      ...validDevOut,
      commits: [{ ...validDevOut.commits[0], sha: 'not-a-sha' }],
    })
    expect(r.success).toBe(false)
  })

  it('accepts fix commit (round 2)', () => {
    const r = DevLoopOutputSchema.safeParse({
      ...validDevOut,
      commits: [{
        ...validDevOut.commits[0],
        message: 'fix(qi-7): T1 修订 — 处理空数组',
        round: 2, isFix: true,
      }],
    })
    expect(r.success).toBe(true)
  })
})

// =============================================================================
// code-quality-reviewer
// =============================================================================

describe('ReviewerOutputSchema', () => {
  const validReviewOut = {
    summary: '审查通过',
    decision: 'pass' as const,
    notes: [],
    evidence: baseEvidence,
    specCoverage: [
      { ac: 'AC-1', covered: true as const, evidence: [{ file: 'web/src/login.tsx', line: 42 }] },
    ],
    scopeViolations: [],
    fileRisks: [
      {
        file: 'web/src/login.tsx',
        role: '登录入口',
        impact: '改动表单逻辑',
        risk: 'medium' as const,
        focusOn: 'localStorage 边界条件 + 表单 reset',
      },
    ],
  }

  it('accepts valid reviewer output', () => {
    const r = ReviewerOutputSchema.safeParse(validReviewOut)
    expect(r.success).toBe(true)
  })

  it('rejects covered AC without evidence', () => {
    const r = ReviewerOutputSchema.safeParse({
      ...validReviewOut,
      specCoverage: [{ ac: 'AC-1', covered: true, evidence: [] }],
    })
    expect(r.success).toBe(false)
  })

  it('accepts uncovered AC with missingReason', () => {
    const r = ReviewerOutputSchema.safeParse({
      ...validReviewOut,
      specCoverage: [{ ac: 'AC-2', covered: false, missingReason: '代码缺失 localStorage 清除逻辑' }],
    })
    expect(r.success).toBe(true)
  })

  it('rejects high-risk with vague focusOn', () => {
    const r = ReviewerOutputSchema.safeParse({
      ...validReviewOut,
      fileRisks: [{ ...validReviewOut.fileRisks[0], risk: 'high' as const, focusOn: '注意' }],
    })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.some((i) => i.message.includes('vague focusOn'))).toBe(true)
    }
  })
})

// =============================================================================
// validateRoleOutput 入口
// =============================================================================

describe('validateRoleOutput', () => {
  it('validates spec-author by name', () => {
    const r = validateRoleOutput('spec-author', {
      summary: 'foo',
      decision: 'pass',
      notes: [],
      evidence: baseEvidence,
      acceptanceCriteria: [{ id: 'AC-1', format: 'given-when-then', text: 'a' }],
      openQuestions: [],
      risks: [{ desc: 'x', severity: 'low' }],
      references: [{ file: 'a.ts', purpose: 'p' }],
      clarifications: [],
    })
    expect(r.ok).toBe(true)
  })

  it('returns errors with paths for invalid output', () => {
    const r = validateRoleOutput('plan-decomposer', { summary: 'foo' }) // missing fields
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors.length).toBeGreaterThan(0)
    }
  })

  it('rejects unknown role', () => {
    const r = validateRoleOutput('unknown-role' as never, {})
    expect(r.ok).toBe(false)
  })
})
