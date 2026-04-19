import client from './client'
import type { BugAnalysisReport } from '../types'

export type BugReportStatusFilter =
  | 'draft'
  | 'published'
  | 'superseded'
  | 'pipeline_success'
  | 'completed'
  | 'aborted'
export type BugReportLevelFilter = 'l1' | 'l2' | 'l3' | 'l4'

export interface GetBugReportsParams {
  productLineId: number
  page?: number
  pageSize?: number
  statuses?: BugReportStatusFilter[]
  levels?: BugReportLevelFilter[]
  signal?: AbortSignal
}

export interface GetBugReportsResponse {
  data: BugAnalysisReport[]
  total: number
  page: number
  pageSize: number
}

// 老接口保留（兼容，不带筛选/分页）
export const getBugAnalysisReports = (productLineId: number, limit = 50) =>
  client.get<{ data: BugAnalysisReport[]; total: number }>('/bug-analysis-reports', {
    params: { product_line_id: productLineId, limit },
  }).then(r => r.data)

/**
 * 带服务端分页 + status/level 筛选。
 * 返回 {data, total, page, pageSize}。
 */
export async function getBugReports(p: GetBugReportsParams): Promise<GetBugReportsResponse> {
  const { productLineId, page = 1, pageSize = 20, statuses, levels, signal } = p
  const params: Record<string, unknown> = {
    product_line_id: productLineId,
    page,
    pageSize,
  }
  if (statuses && statuses.length > 0) params.status = statuses.join(',')
  if (levels && levels.length > 0) params.level = levels.join(',')
  const { data } = await client.get<{
    data: BugAnalysisReport[]
    total: number
    page: number
    pageSize: number
  }>('/bug-analysis-reports', { params, signal })
  return data
}

export const getBugAnalysisReport = (id: number) =>
  client.get<{ data: BugAnalysisReport }>(`/bug-analysis-reports/${id}`).then(r => r.data.data)

export interface RetryBugReportResult {
  newReportId: number
  newRunId?: number
  issueId: number
  issueUrl: string
}

export async function retryBugReport(id: number): Promise<RetryBugReportResult> {
  const { data } = await client.post<{
    success: boolean
    error?: string
    message?: string
    data?: RetryBugReportResult
  }>(`/bug-reports/${id}/retry`)
  if (!data.success || !data.data) {
    throw new Error(data.message ?? data.error ?? 'retry failed')
  }
  return data.data
}

export interface BugFixEvent {
  id: number
  reportId: number
  projectPath: string | null
  code: string
  status: 'success' | 'failed'
  durationMs: number | null
  data: Record<string, unknown>
  createdAt: string
}

export async function fetchBugEvents(reportId: number): Promise<BugFixEvent[]> {
  const { data } = await client.get<{ data: BugFixEvent[] }>(`/bug-reports/${reportId}/events`)
  return data.data
}
