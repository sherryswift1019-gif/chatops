import client from './client'
import type { TestServer } from '../types'

export const getTestServers = (productLineId?: number) =>
  client.get<TestServer[]>('/test-servers', { params: productLineId ? { product_line_id: productLineId } : {} }).then(r => r.data)
export const createTestServer = (body: Partial<TestServer>) =>
  client.post<TestServer>('/test-servers', body).then(r => r.data)
export const updateTestServer = (id: number, body: Partial<TestServer>) =>
  client.put<TestServer>(`/test-servers/${id}`, body).then(r => r.data)
export const deleteTestServer = (id: number) => client.delete(`/test-servers/${id}`)
export const testServerConnection = (id: number) =>
  client.post<{ success: boolean; output: string }>(`/test-servers/${id}/test-connection`).then(r => r.data)
