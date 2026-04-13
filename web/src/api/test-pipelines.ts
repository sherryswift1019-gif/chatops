import client from './client'
import type { TestPipeline } from '../types'

export const getTestPipelines = (productLineId?: number) =>
  client.get<TestPipeline[]>('/test-pipelines', { params: productLineId ? { product_line_id: productLineId } : {} }).then(r => r.data)
export const getTestPipeline = (id: number) =>
  client.get<TestPipeline>(`/test-pipelines/${id}`).then(r => r.data)
export const createTestPipeline = (body: Partial<TestPipeline>) =>
  client.post<TestPipeline>('/test-pipelines', body).then(r => r.data)
export const updateTestPipeline = (id: number, body: Partial<TestPipeline>) =>
  client.put<TestPipeline>(`/test-pipelines/${id}`, body).then(r => r.data)
export const deleteTestPipeline = (id: number) => client.delete(`/test-pipelines/${id}`)
