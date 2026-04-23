import client from './client'

export interface PrdMetricsSummary {
  sampleSize: number
  firstRoundPassed: number
  firstRoundPassRate: number | null
  escalated: number
  escalationRate: number | null
  avgReviewDurationMs: number | null
  p50ReviewDurationMs: number | null
  findingsByRuleId: Array<{ ruleId: string; count: number }>
  findingsBySeverity: Array<{ severity: string; count: number }>
  avgLlmCallsPerPrd: number | null
}

export interface PrdMetricsResponse {
  windowDays: number
  productLineId: number | null
  summary: PrdMetricsSummary
}

export const getPrdMetrics = (params: {
  days?: number
  productLineId?: number | null
}) =>
  client
    .get<{ data: PrdMetricsResponse }>('/prd/metrics', {
      params: {
        days: params.days,
        product_line_id: params.productLineId ?? undefined,
      },
    })
    .then((r) => r.data.data)
