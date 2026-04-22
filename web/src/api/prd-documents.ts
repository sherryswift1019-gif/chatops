import client from './client'
import type { PrdDocument, PrdStatus } from '../types'

export const listPrdDocuments = (params: {
  productLineId?: number
  status?: PrdStatus
  createdBy?: string
  limit?: number
  offset?: number
}) =>
  client
    .get<{ data: PrdDocument[]; total: number }>('/prd-documents', {
      params: {
        product_line_id: params.productLineId,
        status: params.status,
        created_by: params.createdBy,
        limit: params.limit,
        offset: params.offset,
      },
    })
    .then((r) => r.data)

export const getPrdDocument = (id: number) =>
  client.get<{ data: PrdDocument }>(`/prd-documents/${id}`).then((r) => r.data.data)

export const updatePrdStatus = (id: number, status: PrdStatus) =>
  client
    .put<{ data: PrdDocument }>(`/prd-documents/${id}/status`, { status })
    .then((r) => r.data.data)

export const submitReviewDecision = (
  id: number,
  body: {
    action: 'approve' | 'approve_with_edits' | 'reject'
    editedMarkdown?: string
    comment?: string
    decidedBy?: string
  }
) =>
  client
    .post<{ data: PrdDocument }>(`/prd-documents/${id}/review-decision`, body)
    .then((r) => r.data.data)

export const rerunPrdReview = (id: number) =>
  client.post<{ data: { prdId: number } }>(`/prd-documents/${id}/rerun-review`).then((r) => r.data.data)

export const deletePrdDocument = (id: number) =>
  client.delete<{ data: { id: number; deleted: boolean } }>(`/prd-documents/${id}`).then((r) => r.data.data)
