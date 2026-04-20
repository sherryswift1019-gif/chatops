import client from './client'
import type { BugAnalysisReport } from '../types'

export type BugReportStatusFilter =
  | 'draft'
  | 'published'
  | 'pipeline_success'
  | 'pending_manual'
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

/**
 * 新版签名：productLineId 可选、支持按 issueId 过滤。
 * 与 getBugReports() 共享后端接口，返回结构相同。
 *
 * 与 getBugReports 的区别：
 * - productLineId 改为可选（用于跨产品线 / 按 issue 直查场景）
 * - 新增 issueId 参数，可精确拉取某 Issue 下的所有报告
 * - status / level 为单值字符串（保留后端多值 CSV 协议的单项用法）
 */
export interface ListReportsParams {
  productLineId?: number
  issueId?: number
  status?: string
  level?: string
  page?: number
  pageSize?: number
  signal?: AbortSignal
}

export async function listBugReports(params: ListReportsParams = {}): Promise<{
  data: BugAnalysisReport[]
  total: number
  page: number
  pageSize: number
}> {
  const qs = new URLSearchParams()
  if (params.productLineId != null) qs.set('product_line_id', String(params.productLineId))
  if (params.issueId != null) qs.set('issueId', String(params.issueId))
  if (params.status) qs.set('status', params.status)
  if (params.level) qs.set('level', params.level)
  if (params.page != null) qs.set('page', String(params.page))
  if (params.pageSize != null) qs.set('pageSize', String(params.pageSize))
  const { data } = await client.get<{
    data: BugAnalysisReport[]
    total: number
    page: number
    pageSize: number
  }>(`/bug-analysis-reports?${qs.toString()}`, { signal: params.signal })
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

export interface HandoverBugReportResult {
  reportId: number
  status: string
}

/**
 * 用户主动把 Bug 转人工接手（V2 MVP）。
 * 状态要求：draft / published / pipeline_success；其他 status 后端返回 409。
 * @param id report id
 * @param comment 可选，用户说明转人工原因
 */
export async function handoverBugReport(
  id: number,
  comment?: string,
): Promise<HandoverBugReportResult> {
  const body = comment && comment.trim().length > 0 ? { comment: comment.trim() } : {}
  const { data } = await client.post<{
    success: boolean
    error?: string
    message?: string
    data?: HandoverBugReportResult
  }>(`/bug-reports/${id}/handover`, body)
  if (!data.success || !data.data) {
    throw new Error(data.message ?? data.error ?? 'handover failed')
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
