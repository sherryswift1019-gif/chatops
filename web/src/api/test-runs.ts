import client from './client'
import type { PaginatedResponse } from './types'
import type { TestRun } from '../types'

export interface TestRunWithUser extends TestRun {
  triggeredByName?: string
  triggeredByAvatar?: string
}

export const getTestRuns = (params: { pipelineId?: number; page: number; limit: number }) =>
  client.get<PaginatedResponse<TestRunWithUser>>('/test-runs', {
    params: {
      ...(params.pipelineId ? { pipeline_id: params.pipelineId } : {}),
      page: params.page,
      limit: params.limit,
    },
  }).then(r => r.data)

export const getTestRun = (id: number) =>
  client.get<TestRunWithUser>(`/test-runs/${id}`).then(r => r.data)

export const triggerTestRun = (body: { pipelineId: number; servers: Record<string, string[]>; triggeredBy?: string }) =>
  client.post<{ runId: number; message: string }>('/test-runs', body).then(r => r.data)
