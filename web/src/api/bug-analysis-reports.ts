import client from './client'
import type { BugAnalysisReport } from '../types'

// 老接口保留（兼容，不带筛选/分页）
export const getBugAnalysisReports = (productLineId: number, limit = 50) =>
  client.get<{ data: BugAnalysisReport[]; total: number }>('/bug-analysis-reports', {
    params: { product_line_id: productLineId, limit },
  }).then(r => r.data)

/**
 * 按条件拉取 Bug 分析报告列表（服务端分页）。
 * 支持按 productLineId / issueId / status / level 过滤。
 * status / level 为单值字符串（沿用后端多值 CSV 协议的单项用法）。
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
  /** 原 report id（本次重试的源头）；不是新 report，新 report 由后台异步创建 */
  reportId: number
  /** 人类可读的受理文案 */
  message: string
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

export interface ForceAbortBugReportResult {
  reportId: number
  status: string
}

/**
 * 管理员强制把 report 标记为 aborted，用于卡死状态（Pipeline stage 进程中断、无自动超时等）。
 * 允许状态：published / pipeline_success / aborted（幂等）。
 * 标记后前端"重试"按钮会显示，让用户重新走整条 Pipeline。
 */
export async function forceAbortBugReport(
  id: number,
  reason?: string,
): Promise<ForceAbortBugReportResult> {
  const body = reason && reason.trim().length > 0 ? { reason: reason.trim() } : {}
  const { data } = await client.post<{
    success: boolean
    error?: string
    message?: string
    data?: ForceAbortBugReportResult
  }>(`/bug-reports/${id}/force-abort`, body)
  if (!data.success || !data.data) {
    throw new Error(data.message ?? data.error ?? 'force-abort failed')
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
