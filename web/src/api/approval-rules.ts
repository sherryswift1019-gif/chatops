import client from './client'
import type { ApprovalRule } from '../types'

export const getApprovalRules = (productLineId?: number) =>
  client.get<ApprovalRule[]>('/approval-rules', { params: productLineId ? { product_line_id: productLineId } : {} }).then(r => r.data)
export const createApprovalRule = (body: Omit<ApprovalRule, 'id'>) =>
  client.post<ApprovalRule>('/approval-rules', body).then(r => r.data)
export const updateApprovalRule = (id: number, body: Partial<ApprovalRule>) =>
  client.put<ApprovalRule>(`/approval-rules/${id}`, body).then(r => r.data)
export const deleteApprovalRule = (id: number) => client.delete(`/approval-rules/${id}`)
