import client from './client'
import type { MetricDaily, KnowledgeHitStat } from '../types'

export const getDailyMetrics = (productLineId: number, metricKey: string, from?: string, to?: string) =>
  client.get<{ data: MetricDaily[] }>('/metrics/daily', {
    params: { product_line_id: productLineId, metric_key: metricKey, from, to },
  }).then(r => r.data.data)

export const getKnowledgeHits = (productLineId: number, limit = 20) =>
  client.get<{ data: KnowledgeHitStat[] }>('/metrics/knowledge-hits', {
    params: { product_line_id: productLineId, limit },
  }).then(r => r.data.data)

export const getAvgDuration = (productLineId: number, from?: string) =>
  client.get<{ data: { avgDurationMs: number | null } }>('/metrics/avg-duration', {
    params: { product_line_id: productLineId, from },
  }).then(r => r.data.data)

export const getRootCauseTrends = (productLineId: number, from?: string) =>
  client.get<{ data: { root_cause_type: string; count: number }[] }>('/metrics/root-cause-trends', {
    params: { product_line_id: productLineId, from },
  }).then(r => r.data.data)
