import client from './client'
import type { PipelineWebhook } from '../types'

export function listPipelineWebhooks(pipelineId: number) {
  return client
    .get<PipelineWebhook[]>(`/pipelines/${pipelineId}/webhooks`)
    .then((r) => r.data)
}

export function createPipelineWebhook(
  pipelineId: number,
  body: { name: string; defaultServers?: Record<string, string[]> },
) {
  return client
    .post<PipelineWebhook & { token: string; url: string }>(
      `/pipelines/${pipelineId}/webhooks`,
      body,
    )
    .then((r) => r.data)
}

export function rotatePipelineWebhook(pipelineId: number, webhookId: number) {
  return client
    .post<{ token: string; url: string }>(
      `/pipelines/${pipelineId}/webhooks/${webhookId}/rotate`,
    )
    .then((r) => r.data)
}

export function updatePipelineWebhook(
  pipelineId: number,
  webhookId: number,
  body: { name?: string; enabled?: boolean; defaultServers?: Record<string, string[]> | null },
) {
  return client
    .patch<PipelineWebhook>(`/pipelines/${pipelineId}/webhooks/${webhookId}`, body)
    .then((r) => r.data)
}

export function deletePipelineWebhook(pipelineId: number, webhookId: number) {
  return client.delete(`/pipelines/${pipelineId}/webhooks/${webhookId}`)
}
