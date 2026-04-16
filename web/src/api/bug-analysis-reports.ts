import client from './client'
import type { BugAnalysisReport } from '../types'

export const getBugAnalysisReports = (productLineId: number, limit = 50) =>
  client.get<{ data: BugAnalysisReport[]; total: number }>('/bug-analysis-reports', {
    params: { product_line_id: productLineId, limit },
  }).then(r => r.data)

export const getBugAnalysisReport = (id: number) =>
  client.get<{ data: BugAnalysisReport }>(`/bug-analysis-reports/${id}`).then(r => r.data.data)
