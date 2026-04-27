import client from './client'

export interface DryRunSnapshot {
  pipelineId: number
  nodeId: string
  status: 'success' | 'failed' | 'skipped'
  output: Record<string, unknown>
  source: 'real' | 'stub' | 'manual'
  upstreamParamsHash: string
  lastDecision: string | null
  lastManualInput: Record<string, unknown> | null
  durationMs: number | null
  error: string | null
  ranAt: string
  stale: boolean
}

export const listSnapshots = (pid: number) =>
  client.get<DryRunSnapshot[]>(`/test-pipelines/${pid}/dry-run/snapshots`).then(r => r.data)

export const clearAllSnapshots = (pid: number) =>
  client.delete(`/test-pipelines/${pid}/dry-run/snapshots`)

export const clearSnapshot = (pid: number, nodeId: string) =>
  client.delete(`/test-pipelines/${pid}/dry-run/snapshots/${encodeURIComponent(nodeId)}`)

export interface RecentTriggerParam {
  runId: number
  triggerType: string
  triggeredBy: string
  triggerParams: Record<string, unknown>
  startedAt: string
  status: string
}

export const listRecentTriggerParams = (pid: number, limit = 20) =>
  client.get<RecentTriggerParam[]>(`/test-pipelines/${pid}/recent-trigger-params?limit=${limit}`)
    .then(r => r.data)

export const decideSideEffect = (
  pid: number, sessionId: string,
  body: { nodeId: string; decision: 'real' | 'stub' | 'manual'; manualOutput?: Record<string, unknown>; remember?: boolean },
) => client.post(`/test-pipelines/${pid}/dry-run/sessions/${sessionId}/decide`, body)
