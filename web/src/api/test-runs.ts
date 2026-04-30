import client from './client'
import type { PaginatedResponse } from './types'
import type { TestRun } from '../types'

export interface TestRunWithUser extends TestRun {
  triggeredByName?: string
  triggeredByAvatar?: string
}

export const getTestRuns = (params: { pipelineId?: number; page: number; limit: number }, signal?: AbortSignal) =>
  client.get<PaginatedResponse<TestRunWithUser>>('/test-runs', {
    params: {
      ...(params.pipelineId ? { pipeline_id: params.pipelineId } : {}),
      page: params.page,
      limit: params.limit,
    },
    signal,
  }).then(r => r.data)

export const getTestRun = (id: number) =>
  client.get<TestRunWithUser>(`/test-runs/${id}`).then(r => r.data)

export const triggerTestRun = (body: {
  pipelineId: number
  servers: Record<string, string[]>
  triggeredBy?: string
  triggerType?: 'manual' | 'api'
  runtimeVars?: Record<string, string>
  params?: Record<string, unknown>
}) =>
  client.post<{ runId: number; message: string }>('/test-runs', body).then(r => r.data)

export interface ResumeTestRunBody {
  approval?: 'approved' | 'rejected' | 'timeout'
  webhookData?: unknown
  webhookTimeout?: true
}

export const resumeTestRun = (id: number, body: ResumeTestRunBody) =>
  client.post<{ ok: boolean; resumed: boolean; interruptType: 'approval' | 'webhook' }>(
    `/test-runs/${id}/resume`,
    body
  ).then(r => r.data)

export interface StageLogResponse {
  runId: number
  stageIndex: number
  filePath: string
  fileType: 'script' | 'capability'
  content: string
}

/**
 * 一次性拉单 stage 的完整日志文件。404 表示没有 log 文件（如 approval / dm
 * 等无落盘的 stage 类型），调用方应回落到 stageResult.output。
 */
export const getStageLog = (runId: number, stageIndex: number, signal?: AbortSignal) =>
  client.get<StageLogResponse>(`/test-runs/${runId}/stage/${stageIndex}/log`, { signal }).then(r => r.data)
