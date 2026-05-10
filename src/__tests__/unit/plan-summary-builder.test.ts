import { describe, it, expect } from 'vitest'
import { buildPlanApprovalSummary } from '../../pipeline/approval-summary/plan.js'
import type {
  PlanDecomposerOutputV3,
  SpecAuthorOutput,
} from '../../quick-impl/role-output-schemas.js'

function makePlan(override: Partial<PlanDecomposerOutputV3> = {}): PlanDecomposerOutputV3 {
  return {
    schemaVersion: 'v2',
    summary: '拆 2 个任务',
    decision: 'pass',
    rejectReasons: [],
    notes: [],
    confidenceLevel: 'high',
    decisions: [],
    tasks: [
      {
        id: 'T1',
        type: 'feature',
        title: '在 src/server.ts 加 uptime 字段',
        files: ['src/server.ts'],
        coverAC: ['AC-1', 'AC-2'],
        dependsOn: [],
        estimatedLoc: 5,
        doneWhen: ['handler 返回 uptime', 'tsc 通过'],
        implementationHints: null,
        testHints: null,
        exposesContract: null,
      },
      {
        id: 'T2',
        type: 'test',
        title: 'GET /health 单测',
        files: ['src/__tests__/unit/health.test.ts'],
        coverAC: ['AC-1', 'AC-2'],
        dependsOn: ['T1'],
        estimatedLoc: 30,
        doneWhen: ['3 case 全绿'],
        implementationHints: null,
        testHints: { framework: 'vitest', casesTitles: ['ok', 'uptime', 'no-extra'] },
        exposesContract: null,
      },
    ],
    migrations: [],
    evidence: { standardsConsulted: [], selfCheck: [] },
    ...override,
  } as PlanDecomposerOutputV3
}

function makeSpec(override: Partial<SpecAuthorOutput> = {}): SpecAuthorOutput {
  return {
    summary: 's',
    decision: 'pass',
    acceptanceCriteria: [
      { id: 'AC-1', text: 'health 返回 status' },
      { id: 'AC-2', text: 'health 返回 uptime' },
      { id: 'AC-3', text: 'uptime 是非负整数' },
    ],
    references: [],
    risks: [{ desc: '影响 health 探针', severity: 'high' as const }],
    notes: [],
    evidence: { standardsConsulted: [], selfCheck: [] },
    ...override,
  } as unknown as SpecAuthorOutput
}

const SAMPLE_PLAN_MD = '# Plan\n\n## 任务\n- T1\n- T2\n'

describe('buildPlanApprovalSummary', () => {
  it('5 段 web 摘要：标题 / AI notes / 概览 / 任务 / 风险', () => {
    const { web } = buildPlanApprovalSummary({
      planSkillOutput: makePlan(),
      lastReview: {
        summary: 'AI 拒了',
        decision: 'fail',
        notes: [
          { severity: 'error', msg: 'AC-3 没任何 task 覆盖' },
          { severity: 'error', msg: 'T1 doneWhen 太空泛' },
          { severity: 'warn', msg: 'estimatedLoc 缺失' },
        ],
      },
      reviewHistory: [{ round: 1, output: { summary: 'r1', notes: [] } }],
      planMdContent: SAMPLE_PLAN_MD,
      specOutput: makeSpec(),
      round: 1,
      aiRejectRounds: 2,
    })
    expect(web).toContain('Plan 评审 · 第 1 轮（AI 已拒绝 2 轮）')
    expect(web).toContain('AI Reviewer 拒绝原因')
    expect(web).toContain('AC-3 没任何 task 覆盖')
    expect(web).toContain('当前 plan 概览')
    expect(web).toContain('2 个任务')
    expect(web).toContain('任务清单')
    expect(web).toContain('| T1 |')
    expect(web).toContain('| T2 |')
    expect(web).toContain('风险 & 取舍')
    expect(web).toContain('影响 health 探针')
    expect(web).toMatch(/<details/)
  })

  it('AC 覆盖矩阵：未覆盖 AC 在概览段标红', () => {
    const { web } = buildPlanApprovalSummary({
      planSkillOutput: makePlan(),
      lastReview: { notes: [] },
      reviewHistory: [],
      planMdContent: SAMPLE_PLAN_MD,
      specOutput: makeSpec(),
      round: 1,
      aiRejectRounds: 2,
    })
    expect(web).toContain('2/3 AC')
    expect(web).toContain('未覆盖：AC-3')
  })

  it('hint：error ≥ 3 → 建议拒绝', () => {
    const { web } = buildPlanApprovalSummary({
      planSkillOutput: makePlan(),
      lastReview: {
        notes: [
          { severity: 'error', msg: 'a' },
          { severity: 'error', msg: 'b' },
          { severity: 'error', msg: 'c' },
        ],
      },
      planMdContent: SAMPLE_PLAN_MD,
      round: 1,
      aiRejectRounds: 2,
    })
    expect(web).toContain('3 条 error，建议拒绝')
  })

  it('hint：未覆盖 AC 优先级最高', () => {
    const { web } = buildPlanApprovalSummary({
      planSkillOutput: makePlan(),
      lastReview: {
        notes: [{ severity: 'error', msg: 'a' }],
      },
      planMdContent: SAMPLE_PLAN_MD,
      specOutput: makeSpec(),
      round: 1,
      aiRejectRounds: 2,
    })
    expect(web).toContain('AC 未覆盖，建议拒绝重拆')
  })

  it('hint：仅 warn → 建议视情况批准', () => {
    const { web } = buildPlanApprovalSummary({
      planSkillOutput: makePlan({
        tasks: [
          {
            id: 'T1',
            type: 'feature',
            title: 'x',
            files: ['src/x.ts'],
            coverAC: ['AC-1', 'AC-2', 'AC-3'],
            dependsOn: [],
            estimatedLoc: 5,
            doneWhen: ['t'],
            implementationHints: null,
            testHints: null,
            exposesContract: null,
          },
        ],
      }),
      lastReview: { notes: [{ severity: 'warn', msg: 'minor' }] },
      planMdContent: SAMPLE_PLAN_MD,
      specOutput: makeSpec(),
      round: 1,
      aiRejectRounds: 2,
    })
    expect(web).toContain('仅 warn 级提示，建议视情况批准')
  })

  it('IM 摘要 ≤ 250 字符 + 含 round/任务/AC', () => {
    const { im } = buildPlanApprovalSummary({
      planSkillOutput: makePlan(),
      lastReview: {
        notes: [{ severity: 'error', msg: 'AC-3 没覆盖' }],
      },
      planMdContent: SAMPLE_PLAN_MD,
      specOutput: makeSpec(),
      round: 1,
      aiRejectRounds: 2,
    })
    expect(im.length).toBeLessThanOrEqual(250)
    expect(im).toContain('Plan 评审 · 第 1 轮')
    expect(im).toContain('AI 拒 2 轮')
    expect(im).toContain('2 任务')
    expect(im).toContain('AC-3 没覆盖')
  })

  it('降级：planSkillOutput 和 lastReview 都为 null → 退回 plan.md 原文', () => {
    const { web, im } = buildPlanApprovalSummary({
      planSkillOutput: null,
      lastReview: null,
      planMdContent: SAMPLE_PLAN_MD,
      round: 1,
      aiRejectRounds: 0,
    })
    expect(web).toBe(SAMPLE_PLAN_MD)
    expect(im).toContain('无结构化数据')
  })

  it('reviewHistory 折叠区：含全部轮次', () => {
    const { web } = buildPlanApprovalSummary({
      planSkillOutput: makePlan(),
      lastReview: { notes: [{ severity: 'error', msg: 'last' }] },
      reviewHistory: [
        { round: 1, output: { summary: 'r1 wrong', notes: [{ severity: 'error', msg: 'r1-issue' }] } },
        { round: 2, output: { summary: 'r2 still wrong', notes: [{ severity: 'error', msg: 'r2-issue' }] } },
      ],
      planMdContent: SAMPLE_PLAN_MD,
      round: 1,
      aiRejectRounds: 2,
    })
    expect(web).toContain('AI Review 全部轮次（2 轮）')
    expect(web).toContain('Round 1')
    expect(web).toContain('r1-issue')
    expect(web).toContain('Round 2')
    expect(web).toContain('r2-issue')
  })

  it('AC 折叠区：覆盖标 ✅ / 未覆盖标 ❌', () => {
    const { web } = buildPlanApprovalSummary({
      planSkillOutput: makePlan(),
      lastReview: { notes: [] },
      planMdContent: SAMPLE_PLAN_MD,
      specOutput: makeSpec(),
      round: 1,
      aiRejectRounds: 2,
    })
    expect(web).toMatch(/✅ \*\*AC-1\*\*/)
    expect(web).toMatch(/✅ \*\*AC-2\*\*/)
    expect(web).toMatch(/❌ \*\*AC-3\*\*/)
  })

  it('round 2+ + reviewHistory 长度>1 → 出现"上一轮 AI reviewer 反馈"段', () => {
    const { web } = buildPlanApprovalSummary({
      planSkillOutput: makePlan(),
      lastReview: { notes: [{ severity: 'error', msg: 'now' }] },
      reviewHistory: [
        { round: 1, output: { notes: [{ severity: 'error', msg: 'prev-r1' }] } },
        { round: 2, output: { notes: [{ severity: 'error', msg: 'prev-r2' }] } },
      ],
      planMdContent: SAMPLE_PLAN_MD,
      round: 2,
      aiRejectRounds: 2,
    })
    expect(web).toContain('上一轮 AI reviewer 反馈')
    expect(web).toContain('prev-r1')
  })
})
