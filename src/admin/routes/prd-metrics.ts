/**
 * PRD Agent V2.0 baseline metrics 聚合 + 只读 API。
 *
 * 对应 docs/prds/prd-agent-v2-iteration.md §3 采集口径：
 *   - 一轮审查即通过率：首次 review 即 status='passed'（review_history[0] 的 result.status）
 *   - 升级人工率：status='review_blocked' 占所有完成 PRD 比例
 *   - 自审总耗时：reviewHistory 跨度（首条 reviewedAt → 末条 repairedAt/reviewedAt），
 *       单位毫秒；聚合为平均 + P50
 *   - findings 分类分布：review_history[*].result.findings[*].dimension 聚合（V2 dimension 承接 ruleId 字符串）
 *
 * 保持只读、无副作用。所有计算走纯函数 computeMetrics() —— Fastify 路由只负责读 DB + 套壳。
 * llmCalls 指标依赖 metrics JSONB 埋点（schema-v18 新增），本切片尚未落埋点填充，
 * 若 metrics 为空则结果中字段返回 null 而非 0（区分"未采集"与"真实为 0"）。
 */

import type { FastifyInstance } from 'fastify'
import { getPool } from '../../db/client.js'
import type {
  PrdReviewResult,
  PrdReviewHistoryEntry,
  PrdStatus,
} from '../../db/repositories/prd-documents.js'

// =============================================================================
// 输入行 / 聚合结果类型
// =============================================================================

export interface PrdMetricsRow {
  id: number
  status: PrdStatus
  createdAt: Date
  updatedAt: Date
  reviewResult: PrdReviewResult | null
  reviewHistory: PrdReviewHistoryEntry[]
  metrics: Record<string, unknown>
}

export interface PrdMetricsSummary {
  /** 纳入统计的 PRD 总数（在时间窗内且 review_history 非空）*/
  sampleSize: number
  /** 首轮即通过的 PRD 数 */
  firstRoundPassed: number
  /** 首轮即通过率：firstRoundPassed / sampleSize，空样本时为 null */
  firstRoundPassRate: number | null
  /** 升级人工：status='review_blocked' 数 */
  escalated: number
  /** 升级人工率：escalated / sampleSize，空样本时为 null */
  escalationRate: number | null
  /** 自审耗时平均（毫秒）。只统计能算出首末时间戳的条目；否则 null */
  avgReviewDurationMs: number | null
  /** 自审耗时 P50（毫秒），口径同上 */
  p50ReviewDurationMs: number | null
  /** findings 聚合（按 dimension 即 V2 ruleId 分桶），desc 排序 */
  findingsByRuleId: Array<{ ruleId: string; count: number }>
  /** severity 分布，desc 排序 */
  findingsBySeverity: Array<{ severity: string; count: number }>
  /** 单份 PRD LLM 调用平均次数（create+review+repair 汇总）。metrics 埋点未上线时为 null */
  avgLlmCallsPerPrd: number | null
}

// =============================================================================
// 纯函数聚合：可直接单测
// =============================================================================

export function computeMetrics(rows: PrdMetricsRow[]): PrdMetricsSummary {
  // 只纳入有审查痕迹的 PRD。drafting 且从未审过的不算分母，避免稀释基线。
  const sample = rows.filter((r) => r.reviewHistory.length > 0)
  const sampleSize = sample.length

  let firstRoundPassed = 0
  let escalated = 0
  const durations: number[] = []
  const ruleBuckets = new Map<string, number>()
  const sevBuckets = new Map<string, number>()
  let llmTotal = 0
  let llmSamples = 0

  for (const r of sample) {
    if (r.reviewHistory[0]?.result?.status === 'passed') firstRoundPassed++
    if (r.status === 'review_blocked') escalated++

    const firstTs = getTs(r.reviewHistory[0]?.result?.reviewedAt)
    const last = r.reviewHistory[r.reviewHistory.length - 1]
    const lastTs =
      getTs(last?.repairedAt) ??
      getTs(last?.result?.reviewedAt) ??
      null
    if (firstTs !== null && lastTs !== null && lastTs >= firstTs) {
      durations.push(lastTs - firstTs)
    }

    for (const entry of r.reviewHistory) {
      for (const f of entry.result?.findings ?? []) {
        const rid = f.dimension || '(unknown)'
        ruleBuckets.set(rid, (ruleBuckets.get(rid) ?? 0) + 1)
        const sev = f.severity || '(unknown)'
        sevBuckets.set(sev, (sevBuckets.get(sev) ?? 0) + 1)
      }
    }

    const calls = extractLlmCalls(r.metrics)
    if (calls !== null) {
      llmTotal += calls
      llmSamples++
    }
  }

  return {
    sampleSize,
    firstRoundPassed,
    firstRoundPassRate: sampleSize > 0 ? firstRoundPassed / sampleSize : null,
    escalated,
    escalationRate: sampleSize > 0 ? escalated / sampleSize : null,
    avgReviewDurationMs:
      durations.length > 0
        ? Math.round(durations.reduce((s, x) => s + x, 0) / durations.length)
        : null,
    p50ReviewDurationMs: durations.length > 0 ? percentile(durations, 0.5) : null,
    findingsByRuleId: [...ruleBuckets.entries()]
      .map(([ruleId, count]) => ({ ruleId, count }))
      .sort((a, b) => b.count - a.count),
    findingsBySeverity: [...sevBuckets.entries()]
      .map(([severity, count]) => ({ severity, count }))
      .sort((a, b) => b.count - a.count),
    avgLlmCallsPerPrd: llmSamples > 0 ? llmTotal / llmSamples : null,
  }
}

function getTs(iso?: string | null): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

function percentile(sorted: number[], p: number): number {
  const arr = [...sorted].sort((a, b) => a - b)
  const idx = Math.min(arr.length - 1, Math.floor(arr.length * p))
  return arr[idx]
}

function extractLlmCalls(metrics: Record<string, unknown>): number | null {
  const calls = (metrics as { llmCalls?: Record<string, unknown> }).llmCalls
  if (!calls || typeof calls !== 'object') return null
  let sum = 0
  let any = false
  for (const v of Object.values(calls)) {
    if (typeof v === 'number' && Number.isFinite(v)) {
      sum += v
      any = true
    }
  }
  return any ? sum : null
}

// =============================================================================
// Fastify 路由
// =============================================================================

export async function registerPrdMetricsRoutes(
  app: FastifyInstance
): Promise<void> {
  app.get('/prd/metrics', async (req) => {
    const q = req.query as Record<string, string | undefined>
    const windowDays = clamp(Number(q.days) || 30, 1, 365)
    const productLineId = q.product_line_id ? Number(q.product_line_id) : null

    const rows = await fetchRows({ windowDays, productLineId })
    return {
      data: {
        windowDays,
        productLineId,
        summary: computeMetrics(rows),
      },
    }
  })
}

interface FetchOpts {
  windowDays: number
  productLineId: number | null
}

async function fetchRows(opts: FetchOpts): Promise<PrdMetricsRow[]> {
  const pool = getPool()
  const since = new Date(Date.now() - opts.windowDays * 86400_000)
  const params: unknown[] = [since]
  let where = 'created_at >= $1'
  if (opts.productLineId !== null) {
    params.push(opts.productLineId)
    where += ` AND product_line_id = $${params.length}`
  }
  const { rows } = await pool.query(
    `SELECT id, status, created_at, updated_at, review_result, review_history, metrics
       FROM prd_documents
      WHERE ${where}`,
    params
  )
  return rows.map((r: Record<string, unknown>) => ({
    id: r.id as number,
    status: r.status as PrdStatus,
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
    reviewResult: r.review_result as PrdReviewResult | null,
    reviewHistory: (r.review_history ?? []) as PrdReviewHistoryEntry[],
    metrics: (r.metrics ?? {}) as Record<string, unknown>,
  }))
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}
