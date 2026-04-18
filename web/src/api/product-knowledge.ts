import client from './client'
import type { ProductKnowledgeRepo } from '../types'

export const getProductKnowledge = (productLineId: number) =>
  client.get<{ data: ProductKnowledgeRepo | null }>(`/product-knowledge/${productLineId}`).then(r => r.data.data)

export const createProductKnowledge = (body: {
  productLineId: number; codeRepoUrl: string; codeDefaultBranch?: string
  knowledgeRepoUrl: string; aiSummaryPath?: string
}) =>
  client.post<{ data: ProductKnowledgeRepo }>('/product-knowledge', body).then(r => r.data.data)

export const updateProductKnowledge = (productLineId: number, body: Partial<ProductKnowledgeRepo>) =>
  client.put<{ data: ProductKnowledgeRepo }>(`/product-knowledge/${productLineId}`, body).then(r => r.data.data)
