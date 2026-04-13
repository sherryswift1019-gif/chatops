import client from './client'
import type { TestRun } from '../types'

export const getTestRuns = (pipelineId?: number, limit?: number) =>
  client.get<TestRun[]>('/test-runs', { params: { ...(pipelineId ? { pipeline_id: pipelineId } : {}), ...(limit ? { limit } : {}) } }).then(r => r.data)
export const getTestRun = (id: number) =>
  client.get<TestRun>(`/test-runs/${id}`).then(r => r.data)
export const triggerTestRun = (body: { pipelineId: number; servers: Record<string, string[]>; triggeredBy?: string }) =>
  client.post<{ runId: number; message: string }>('/test-runs', body).then(r => r.data)
