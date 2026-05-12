import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { buildSpecApprovalSummary } from '../../pipeline/approval-summary/spec.js'
import { computeHeuristicHint, parseFeedbackForSummary, truncateImSummary } from '../../pipeline/approval-summary/shared.js'
import type { SpecAuthorOutput } from '../../quick-impl/role-output-schemas.js'

const __filename = fileURLToPath(import.meta.url)
const FIXTURE_DIR = join(dirname(__filename), '..', 'fixtures', 'spec-author')

function loadFixture(name: string): SpecAuthorOutput {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8')) as SpecAuthorOutput
}

const SAMPLE_SPEC_MD = `# Spec\n\n## 1. 背景\n内容\n\n## 2. AC\n- AC-1\n`

describe('buildSpecApprovalSummary', () => {
  it('baseline: v3-full Round 1 → web 含 5 段标题', () => {
    const skillOutput = loadFixture('v3-full.json')
    const { web } = buildSpecApprovalSummary({
      skillOutput,
      specMdContent: SAMPLE_SPEC_MD,
      round: 1,
    })
    expect(web).toContain('Spec 评审 · 第 1 轮')
    expect(web).toContain('本次评估')
    expect(web).toContain('需要你 review 的点')
    expect(web).toContain('LLM 替你做的决定')
    expect(web).toContain('范围')
    expect(web).toMatch(/<details/)
  })

  it('hint=看起来可快速批：confidence=high + 全 low risk + 无 high reviewHints', () => {
    const skillOutput = loadFixture('v3-minimal.json')  // confidence=high, risks low, reviewHints empty
    const { web } = buildSpecApprovalSummary({
      skillOutput,
      specMdContent: SAMPLE_SPEC_MD,
      round: 1,
    })
    expect(web).toContain('看起来可快速批')
  })

  it('hint=建议关注 high 风险：reviewHints 含 high', () => {
    const skillOutput = loadFixture('v3-minimal.json') as SpecAuthorOutput & { reviewHints: any[] }
    skillOutput.reviewHints = [{ severity: 'high', point: 'X', reason: 'Y' }]
    const { web } = buildSpecApprovalSummary({
      skillOutput,
      specMdContent: SAMPLE_SPEC_MD,
      round: 1,
    })
    expect(web).toContain('建议关注下方 high 风险')
  })

  it('hint=建议 escalation：round=3', () => {
    const skillOutput = loadFixture('v3-minimal.json')
    const { web } = buildSpecApprovalSummary({
      skillOutput,
      specMdContent: SAMPLE_SPEC_MD,
      round: 3,
    })
    expect(web).toContain('建议 escalation')
  })

  it('assumption 表格渲染 3 列（主题/默认决定/反对条件）', () => {
    const skillOutput = loadFixture('v3-full.json')
    const { web } = buildSpecApprovalSummary({
      skillOutput,
      specMdContent: SAMPLE_SPEC_MD,
      round: 1,
    })
    expect(web).toContain('| 主题 | 默认决定 | 反对条件 |')
  })

  it('Round 2 双栏：feedbackMd + acDiff 并列展示', () => {
    const skillOutput = loadFixture('v3-full.json')
    const feedbackMd = `# Feedback

## 拒绝原因

> AC-3 文案模糊
> 缺少多 Tab 同步

## Reviewer 标记

- 风险段太薄
`
    const { web } = buildSpecApprovalSummary({
      skillOutput,
      specMdContent: SAMPLE_SPEC_MD,
      round: 2,
      feedbackMd,
      acDiff: {
        added: [{ id: 'AC-6', text: '多 Tab 同步' }],
        removed: ['AC-5'],
        changed: [{ id: 'AC-3', oldText: '清除', newText: 'removeItem' }],
      },
    })
    expect(web).toContain('Round 2')
    expect(web).toContain('上轮反馈')
    expect(web).toContain('AC 变化')
    expect(web).toContain('AC-3 文案模糊')
    expect(web).toContain('AC-6')
    expect(web).toContain('AC-5')
  })

  it('IM 摘要 ≤ 250 字符（v3-full + 长 reason）', () => {
    const skillOutput = loadFixture('v3-full.json') as SpecAuthorOutput & { reviewHints: any[] }
    skillOutput.reviewHints = [{
      severity: 'high',
      point: '一个超长的 review 点：' + 'x'.repeat(300),
      reason: 'reason ' + 'y'.repeat(300),
    }]
    const { im } = buildSpecApprovalSummary({
      skillOutput,
      specMdContent: SAMPLE_SPEC_MD,
      round: 1,
    })
    expect(im.length).toBeLessThanOrEqual(250)
  })

  it('skillOutput=null 降级：返回 spec.md 原文 + IM fallback', () => {
    const longSpec = '# Spec\n\n' + 'a'.repeat(5000)
    const { web, im } = buildSpecApprovalSummary({
      skillOutput: null,
      specMdContent: longSpec,
      round: 1,
    })
    expect(web).toBe(longSpec)
    expect(im).toContain('请见 Web 端')
    expect(im.length).toBeLessThanOrEqual(250)
  })

  it('折叠区 4 段：AC / refs / clarifs / spec.md', () => {
    const skillOutput = loadFixture('v3-full.json')
    const { web } = buildSpecApprovalSummary({
      skillOutput,
      specMdContent: SAMPLE_SPEC_MD,
      round: 1,
    })
    expect(web).toContain('<details><summary>📋 验收标准')
    expect(web).toContain('<details><summary>📍 涉及代码')
    expect(web).toContain('<details><summary>❓ 完整澄清问题')
    expect(web).toMatch(/<details(?:\s+open)?><summary>📄 完整 spec\.md/)
  })

  it('spec.md > 50KB 时折叠区不带 open（默认收起防 ReactMarkdown 卡顿）', () => {
    const skillOutput = loadFixture('v3-minimal.json')
    const largeSpec = 'x'.repeat(60_000)
    const { web } = buildSpecApprovalSummary({
      skillOutput,
      specMdContent: largeSpec,
      round: 1,
    })
    // 大 spec：summary 标签前一个字符不是 'open'
    expect(web).toMatch(/<details><summary>📄 完整 spec\.md/)
    expect(web).not.toMatch(/<details open><summary>📄 完整 spec\.md/)
  })

  it('reviewHints > 5 显示前 5 条 + "另有 N 条"', () => {
    const skillOutput = loadFixture('v3-minimal.json') as SpecAuthorOutput & { reviewHints: any[] }
    skillOutput.reviewHints = Array.from({ length: 8 }, (_, i) => ({
      severity: 'medium' as const,
      point: `point ${i}`,
      reason: `reason ${i}`,
    }))
    const { web } = buildSpecApprovalSummary({
      skillOutput,
      specMdContent: SAMPLE_SPEC_MD,
      round: 1,
    })
    expect(web).toContain('另有 3 条详见折叠区')
    // 前 5 个 point 都在
    for (let i = 0; i < 5; i++) expect(web).toContain(`point ${i}`)
    // 第 6 个不应在主摘要里（折叠区也没专门 reviewHints 全列；这是设计 — 折叠区不重复 hint）
  })

  it('reviewHints 空数组时显示 "LLM 无主动提示，请抽查"', () => {
    const skillOutput = loadFixture('v3-minimal.json')  // empty reviewHints
    const { web } = buildSpecApprovalSummary({
      skillOutput,
      specMdContent: SAMPLE_SPEC_MD,
      round: 1,
    })
    expect(web).toContain('LLM 无主动提示，请抽查')
  })

  it('性能：< 50ms（v3-full 输入）', () => {
    const skillOutput = loadFixture('v3-full.json')
    const start = performance.now()
    buildSpecApprovalSummary({
      skillOutput,
      specMdContent: SAMPLE_SPEC_MD,
      round: 1,
    })
    const elapsed = performance.now() - start
    expect(elapsed).toBeLessThan(50)
  })

  // ─── Low Confidence Signal（AC-1/2/3）──────────────────────
  it('AC-1: confidenceLevel=low 优先级最高 — 同时存在 high reviewHints / high risks / round=3 时仍返回 HINT_LOW_CONFIDENCE', () => {
    const skillOutput = loadFixture('v3-minimal.json')
    skillOutput.confidenceLevel = 'low'
    ;(skillOutput as { reviewHints: Array<{ severity: string; point: string; reason: string }> }).reviewHints = [
      { severity: 'high', point: 'X', reason: 'Y' },
    ]
    ;(skillOutput as { risks: Array<{ severity: string; desc: string }> }).risks = [
      { severity: 'high', desc: 'Z' },
    ]
    const { web } = buildSpecApprovalSummary({
      skillOutput,
      specMdContent: SAMPLE_SPEC_MD,
      round: 3,
    })
    expect(web).toContain('LLM 自信度低，请细审')
    expect(web).not.toContain('看起来可快速批')
    expect(web).not.toContain('建议 escalation')
  })

  it('AC-2: confidenceLevel=high 仍返回 HINT_QUICK_PASS（不回归）', () => {
    const skillOutput = loadFixture('v3-minimal.json')  // 已是 high + 全 low risk + 空 reviewHints
    const { web } = buildSpecApprovalSummary({
      skillOutput,
      specMdContent: SAMPLE_SPEC_MD,
      round: 1,
    })
    expect(web).toContain('看起来可快速批')
    expect(web).not.toContain('LLM 自信度低')
  })

  it('AC-3: 无 confidenceLevel 字段时按旧优先级走（high reviewHint → HINT_HIGH_RISK）', () => {
    const skillOutput = loadFixture('v3-minimal.json') as { reviewHints: Array<{ severity: string; point: string; reason: string }>; confidenceLevel?: string }
    delete skillOutput.confidenceLevel
    skillOutput.reviewHints = [{ severity: 'high', point: 'X', reason: 'Y' }]
    const { web } = buildSpecApprovalSummary({
      skillOutput: skillOutput as Parameters<typeof buildSpecApprovalSummary>[0]['skillOutput'],
      specMdContent: SAMPLE_SPEC_MD,
      round: 1,
    })
    expect(web).toContain('建议关注下方 high 风险')
    expect(web).not.toContain('LLM 自信度低')
  })

  it('AC-4: confidenceLevel=low → web 含 🔴 **置信度: low**（加粗）', () => {
    const skillOutput = loadFixture('v3-minimal.json')
    skillOutput.confidenceLevel = 'low'
    const { web } = buildSpecApprovalSummary({
      skillOutput,
      specMdContent: SAMPLE_SPEC_MD,
      round: 1,
    })
    expect(web).toContain('🔴 **置信度: low**')
  })

  it('AC-5: confidenceLevel=high → web 含 🟢 置信度: high（不加粗）', () => {
    const skillOutput = loadFixture('v3-minimal.json')  // 已是 high
    const { web } = buildSpecApprovalSummary({
      skillOutput,
      specMdContent: SAMPLE_SPEC_MD,
      round: 1,
    })
    expect(web).toContain('🟢 置信度: high')
    expect(web).not.toContain('🔴 **置信度')
  })
})

describe('parseFeedbackForSummary', () => {
  it('提取 ## 拒绝原因 段的 blockquote', () => {
    const md = `## 拒绝原因\n\n> reason 1\n> reason 2\n\n## 其他\n`
    const result = parseFeedbackForSummary(md)
    expect(result.rejectReasons).toEqual(['reason 1', 'reason 2'])
  })

  it('提取 ## Reviewer 标记 段的 bullet 列表', () => {
    const md = `## Reviewer 标记\n\n- note 1\n- note 2\n\n## 其他\n`
    const result = parseFeedbackForSummary(md)
    expect(result.reviewerNotes).toEqual(['note 1', 'note 2'])
  })

  it('解析失败 → 返回空数组（残缺 feedback.md）', () => {
    const result = parseFeedbackForSummary('# 无标准段落的随便文本\n')
    expect(result.rejectReasons).toEqual([])
    expect(result.reviewerNotes).toEqual([])
  })
})

describe('computeHeuristicHint 优先级', () => {
  function fakeOutput(overrides: Partial<SpecAuthorOutput> = {}): SpecAuthorOutput {
    return {
      schemaVersion: 'v2',
      summary: 'x',
      decision: 'pass',
      notes: [],
      confidenceLevel: 'high',
      reviewHints: [],
      noGos: [],
      evidence: { standardsConsulted: [], selfCheck: [] },
      acceptanceCriteria: [],
      openQuestions: [],
      risks: [],
      references: [],
      clarifications: [],
      ...overrides,
    } as SpecAuthorOutput
  }

  it('reviewHints.high > risks.high > round≥3 > confidence', () => {
    // reviewHints high 存在 → 即使 confidence=high 也 high risk hint
    const out1 = fakeOutput({
      reviewHints: [{ severity: 'high', point: 'x', reason: 'y' }],
    })
    expect(computeHeuristicHint({ skillOutput: out1, round: 1 })).toContain('high 风险')

    // 无 reviewHints high，但 risks.high 存在
    const out2 = fakeOutput({
      risks: [{ desc: 'x', severity: 'high' }],
    })
    expect(computeHeuristicHint({ skillOutput: out2, round: 1 })).toContain('high 风险')

    // 无 high，但 round=3 → escalation
    expect(computeHeuristicHint({ skillOutput: fakeOutput(), round: 3 })).toContain('escalation')

    // round=1 + confidence=high + 无 high → 快速批
    expect(computeHeuristicHint({ skillOutput: fakeOutput(), round: 1 })).toContain('看起来可快速批')

    // confidence=medium + round<3 → 不给主动提示
    const out5 = fakeOutput({ confidenceLevel: 'medium' })
    expect(computeHeuristicHint({ skillOutput: out5, round: 1 })).toBe('')
  })
})

describe('truncateImSummary', () => {
  it('短于上限不截断', () => {
    expect(truncateImSummary('hello', 100)).toBe('hello')
  })

  it('超上限截断 + 省略号', () => {
    const result = truncateImSummary('a'.repeat(300), 100)
    expect(result.length).toBe(100)
    expect(result).toMatch(/…$/)
  })
})
