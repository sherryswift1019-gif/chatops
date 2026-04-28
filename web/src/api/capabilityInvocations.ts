import client from './client'
import type { PaginatedResponse } from './types'

export interface CapabilityInvocation {
  id: number
  capabilityKey: string
  triggerType: string
  platform: string
  groupId: string
  triggeredBy: string
  taskId: string
  status: 'running' | 'success' | 'failed'
  params: Record<string, unknown>
  output: string
  errorMessage: string
  durationMs: number | null
  parentPipelineRunId: number | null
  startedAt: string
  finishedAt: string | null
}

export interface CapabilityInvocationWithUser extends CapabilityInvocation {
  triggeredByName?: string
  triggeredByAvatar?: string
}

export const getCapabilityInvocations = (
  params: {
    capabilityKey?: string
    platform?: string
    status?: string
    page: number
    limit: number
  },
  signal?: AbortSignal,
) =>
  client
    .get<PaginatedResponse<CapabilityInvocationWithUser>>(
      '/capability-invocations',
      {
        params: {
          ...(params.capabilityKey ? { capability_key: params.capabilityKey } : {}),
          ...(params.platform ? { platform: params.platform } : {}),
          ...(params.status ? { status: params.status } : {}),
          page: params.page,
          limit: params.limit,
        },
        signal,
      },
    )
    .then((r) => r.data)

export const getCapabilityInvocation = (id: number) =>
  client
    .get<CapabilityInvocationWithUser>(`/capability-invocations/${id}`)
    .then((r) => r.data)
