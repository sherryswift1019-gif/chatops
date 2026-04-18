import client from './client'
import type { BugAnalysisReport } from '../types'

export const getBugAnalysisReports = (productLineId: number, limit = 50) =>
  client.get<{ data: BugAnalysisReport[]; total: number }>('/bug-analysis-reports', {
    params: { product_line_id: productLineId, limit },
  }).then(r => r.data)

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
