/**
 * computeMetrics 单元测试 —— 对应 src/admin/routes/prd-metrics.ts。
 *
 * 只测纯函数 computeMetrics()，不涉及 DB / Fastify。
 * 覆盖：空样本、sampleSize 过滤、首轮通过率、升级率、耗时 P50、findings 分桶、
 *      llmCalls null 与非零、severity 分布、排序稳定性。
 */

import { describe, it, expect } from 'vitest'
import {
  computeMetrics,
  type PrdMetricsRow,
} from '../../admin/routes/prd-metrics.js'
import type {
  PrdReviewFinding,
  PrdReviewHistoryEntry,
  PrdStatus,
} from '../../db/repositories/prd-documents.js'

// =============================================================================
// 构造工具
// =============================================================================

function mkFinding(partial: Partial<PrdReviewFinding> = {}): PrdReviewFinding {
  return {
    id: partial.id ?? 'f1',
    dimension: partial.dimension ?? 'source_traceable',
    severity: partial.severity ?? 'blocker',
    location: partial.location ?? '§2',
    description: partial.description ?? 'missing source',
    canAutoFix: partial.canAutoFix ?? false,
    ...partial,
  }
}

function mkEntry(
  round: number,
  status: 'passed' | 'blocked',
  reviewedAt: string,
  findings: PrdReviewFinding[] = [],
  repairedAt?: string
): PrdReviewHistoryEntry {
  return {
    round,
    result: { status, round, findings, reviewedAt },
    repairedAt,
  }
}

function mkRow(opts: {
  id: number
  status: PrdStatus
  history: PrdReviewHistoryEntry[]
  metrics?: Record<string, unknown>
}): PrdMetricsRow {
  return {
    id: opts.id,
    status: opts.status,
    createdAt: new Date('2026-04-01'),
    updatedAt: new Date('2026-04-01'),
    reviewResult:
      opts.history.length > 0
        ? opts.history[opts.history.length - 1].result
        : null,
    reviewHistory: opts.history,
    metrics: opts.metrics ?? {},
  }
}

// =============================================================================
// 空样本与 sampleSize 过滤
// =============================================================================

describe('computeMetrics 空样本与过滤', () => {
  it('零行：所有比率/耗时为 null，sampleSize=0', () => {
    const out = computeMetrics([])
    expect(out.sampleSize).toBe(0)
    expect(out.firstRoundPassed).toBe(0)
    expect(out.escalated).toBe(0)
    expect(out.firstRoundPassRate).toBeNull()
    expect(out.escalationRate).toBeNull()
    expect(out.avgReviewDurationMs).toBeNull()
    expect(out.p50ReviewDurationMs).toBeNull()
    expect(out.findingsByRuleId).toEqual([])
    expect(out.findingsBySeverity).toEqual([])
    expect(out.avgLlmCallsPerPrd).toBeNull()
  })

  it('reviewHistory 为空的 PRD 不纳入分母（drafting 中未审过）', () => {
    const rows: PrdMetricsRow[] = [
      mkRow({ id: 1, status: 'drafting', history: [] }),
      mkRow({
        id: 2,
        status: 'draft',
        history: [mkEntry(1, 'passed', '2026-04-01T00:00:00Z')],
      }),
    ]
    const out = computeMetrics(rows)
    expect(out.sampleSize).toBe(1)
    expect(out.firstRoundPassed).toBe(1)
    expect(out.firstRoundPassRate).toBe(1)
  })
})

// =============================================================================
// 首轮通过率 / 升级人工率
// =============================================================================

describe('computeMetrics 比率计算', () => {
  it('firstRoundPassRate = 首轮 passed 数 / sampleSize', () => {
    const rows: PrdMetricsRow[] = [
      mkRow({
        id: 1,
        status: 'draft',
        history: [mkEntry(1, 'passed', '2026-04-01T00:00:00Z')],
      }),
      mkRow({
        id: 2,
        status: 'draft',
        history: [
          mkEntry(1, 'blocked', '2026-04-01T00:00:00Z', [mkFinding()]),
          mkEntry(2, 'passed', '2026-04-01T01:00:00Z'),
        ],
      }),
      mkRow({
        id: 3,
        status: 'draft',
        history: [mkEntry(1, 'passed', '2026-04-01T00:00:00Z')],
      }),
    ]
    const out = computeMetrics(rows)
    expect(out.sampleSize).toBe(3)
    expect(out.firstRoundPassed).toBe(2)
    expect(out.firstRoundPassRate).toBeCloseTo(2 / 3, 6)
  })

  it('escalationRate = status=review_blocked 的数量 / sampleSize', () => {
    const rows: PrdMetricsRow[] = [
      mkRow({
        id: 1,
        status: 'review_blocked',
        history: [mkEntry(1, 'blocked', '2026-04-01T00:00:00Z', [mkFinding()])],
      }),
      mkRow({
        id: 2,
        status: 'draft',
        history: [mkEntry(1, 'passed', '2026-04-01T00:00:00Z')],
      }),
    ]
    const out = computeMetrics(rows)
    expect(out.escalated).toBe(1)
    expect(out.escalationRate).toBe(0.5)
  })
})

// =============================================================================
// 自审耗时聚合（平均 + P50）
// =============================================================================

describe('computeMetrics 耗时聚合', () => {
  it('取首条 reviewedAt 到末条 repairedAt/reviewedAt 的跨度', () => {
    const rows: PrdMetricsRow[] = [
      mkRow({
        id: 1,
        status: 'draft',
        history: [
          // 首轮 blocked → 修复 → 复审 passed。耗时 = 10 分钟。
          mkEntry(
            1,
            'blocked',
            '2026-04-01T00:00:00Z',
            [mkFinding()],
            '2026-04-01T00:05:00Z'
          ),
          mkEntry(2, 'passed', '2026-04-01T00:10:00Z'),
        ],
      }),
      mkRow({
        id: 2,
        status: 'draft',
        history: [
          // 单轮通过：耗时 = 0
          mkEntry(1, 'passed', '2026-04-01T00:00:00Z'),
        ],
      }),
    ]
    const out = computeMetrics(rows)
    expect(out.avgReviewDurationMs).toBe(Math.round((10 * 60_000 + 0) / 2))
    // P50 —— 排序后取索引 1 → 10 分钟
    expect(out.p50ReviewDurationMs).toBe(10 * 60_000)
  })

  it('无法解析时间戳时不计入耗时样本（不污染均值）', () => {
    const rows: PrdMetricsRow[] = [
      mkRow({
        id: 1,
        status: 'draft',
        history: [mkEntry(1, 'passed', 'not-a-date')],
      }),
      mkRow({
        id: 2,
        status: 'draft',
        history: [mkEntry(1, 'passed', '2026-04-01T00:00:00Z')],
      }),
    ]
    const out = computeMetrics(rows)
    // 只有第 2 行贡献耗时，avg=0、p50=0
    expect(out.avgReviewDurationMs).toBe(0)
    expect(out.p50ReviewDurationMs).toBe(0)
  })
})

// =============================================================================
// findings 分类 / severity 分布
// =============================================================================

describe('computeMetrics findings 分桶', () => {
  it('按 dimension 聚合（V2 ruleId 承接于 dimension），desc 排序', () => {
    const rows: PrdMetricsRow[] = [
      mkRow({
        id: 1,
        status: 'review_blocked',
        history: [
          mkEntry(1, 'blocked', '2026-04-01T00:00:00Z', [
            mkFinding({ id: 'a', dimension: 'source_traceable' }),
            mkFinding({ id: 'b', dimension: 'source_traceable' }),
            mkFinding({ id: 'c', dimension: 'closed_loop' }),
          ]),
        ],
      }),
      mkRow({
        id: 2,
        status: 'review_blocked',
        history: [
          mkEntry(1, 'blocked', '2026-04-01T00:00:00Z', [
            mkFinding({ id: 'd', dimension: 'closed_loop' }),
          ]),
        ],
      }),
    ]
    const out = computeMetrics(rows)
    // 两个桶计数相等时 sort 只保证 desc、不保证桶间次序，用集合比较避免假阳性
    const s = new Set(out.findingsByRuleId.map((x) => `${x.ruleId}:${x.count}`))
    expect(s).toEqual(new Set(['source_traceable:2', 'closed_loop:2']))
    // desc 排序不变式：第一个桶的 count 不小于第二个
    expect(out.findingsByRuleId[0].count).toBeGreaterThanOrEqual(
      out.findingsByRuleId[1].count
    )
  })

  it('severity 按计数 desc 分桶', () => {
    const rows: PrdMetricsRow[] = [
      mkRow({
        id: 1,
        status: 'review_blocked',
        history: [
          mkEntry(1, 'blocked', '2026-04-01T00:00:00Z', [
            mkFinding({ id: 'a', severity: 'blocker' }),
            mkFinding({ id: 'b', severity: 'blocker' }),
            mkFinding({ id: 'c', severity: 'major' }),
          ]),
        ],
      }),
    ]
    const out = computeMetrics(rows)
    expect(out.findingsBySeverity[0]).toEqual({ severity: 'blocker', count: 2 })
    expect(out.findingsBySeverity[1]).toEqual({ severity: 'major', count: 1 })
  })

  it('缺失 dimension 或 severity 归入 "(unknown)"', () => {
    const rows: PrdMetricsRow[] = [
      mkRow({
        id: 1,
        status: 'review_blocked',
        history: [
          mkEntry(1, 'blocked', '2026-04-01T00:00:00Z', [
            mkFinding({
              id: 'a',
              dimension: '',
              severity: '' as PrdReviewFinding['severity'],
            }),
          ]),
        ],
      }),
    ]
    const out = computeMetrics(rows)
    expect(out.findingsByRuleId[0].ruleId).toBe('(unknown)')
    expect(out.findingsBySeverity[0].severity).toBe('(unknown)')
  })
})

// =============================================================================
// LLM 调用数：埋点未上线 → null；有数据 → 平均
// =============================================================================

describe('computeMetrics LLM 调用数', () => {
  it('所有 metrics 为空时 avgLlmCallsPerPrd = null（"未采集"而非 0）', () => {
    const rows: PrdMetricsRow[] = [
      mkRow({
        id: 1,
        status: 'draft',
        history: [mkEntry(1, 'passed', '2026-04-01T00:00:00Z')],
      }),
    ]
    const out = computeMetrics(rows)
    expect(out.avgLlmCallsPerPrd).toBeNull()
  })

  it('至少一行有 llmCalls 时取平均（缺失的行不计入分母）', () => {
    const rows: PrdMetricsRow[] = [
      mkRow({
        id: 1,
        status: 'draft',
        history: [mkEntry(1, 'passed', '2026-04-01T00:00:00Z')],
        metrics: { llmCalls: { create: 3, review: 1 } },
      }),
      mkRow({
        id: 2,
        status: 'draft',
        history: [mkEntry(1, 'passed', '2026-04-01T00:00:00Z')],
        metrics: { llmCalls: { create: 2, review: 1, repair: 1 } },
      }),
      mkRow({
        id: 3,
        status: 'draft',
        history: [mkEntry(1, 'passed', '2026-04-01T00:00:00Z')],
        metrics: {},
      }),
    ]
    const out = computeMetrics(rows)
    // 行 1: 4 | 行 2: 4 | 行 3: null（不计）→ avg = 4
    expect(out.avgLlmCallsPerPrd).toBe(4)
  })

  it('llmCalls 不是对象或 value 非 number 时视为未采集', () => {
    const rows: PrdMetricsRow[] = [
      mkRow({
        id: 1,
        status: 'draft',
        history: [mkEntry(1, 'passed', '2026-04-01T00:00:00Z')],
        metrics: { llmCalls: 'oops' as unknown as object },
      }),
      mkRow({
        id: 2,
        status: 'draft',
        history: [mkEntry(1, 'passed', '2026-04-01T00:00:00Z')],
        metrics: { llmCalls: { create: 'x' } },
      }),
    ]
    const out = computeMetrics(rows)
    expect(out.avgLlmCallsPerPrd).toBeNull()
  })
})
