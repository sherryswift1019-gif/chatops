// web/src/api/e2e-runs.ts
import client from './client'

export interface E2eRunDTO {
  id: string
  targetProjectId: string
  triggerType: string
  triggerActor: string | null
  sourceBranch: string
  iterationBranch: string
  status: 'pending' | 'running' | 'awaiting_fix' | 'passed' | 'failed' | 'aborted'
  governorState: {
    perScenarioAttempts?: Record<string, number>
    totalAttempts?: number
    runStartedAt?: number
    limits?: {
      maxPerScenarioAttempts?: number
      maxRunHours?: number
      maxTotalAttempts?: number
    }
  }
  summaryMrUrl: string | null
  startedAt: string
  finishedAt: string | null
  abortReason: string | null
}

export interface E2eSandboxDTO {
  id: string
  kind: string
  handle: {
    envId: string
    endpoints: Record<string, string>
    modules?: Array<{ name: string; host: string; port: number }>
  }
  status: 'provisioning' | 'ready' | 'redeploying' | 'torn_down' | 'failed'
}

export interface AiDiagnosis {
  verdict: string
  rootCauseSummary: string
  fixCommitSha: string | null
  fixedFiles: string[]
  success: boolean
  failureReason: string
}

export interface EvidenceArtifact {
  kind: string
  mimeType: string
  path: string
  description: string
  module?: string
}

export interface EvidenceManifest {
  summary: string
  contextHint: string
  artifacts: EvidenceArtifact[]
  aiDiagnosis?: AiDiagnosis
}

export interface E2eScenarioRunDTO {
  id: string
  scenarioId: string
  scenarioName: string | null
  attemptNumber: number
  result: 'pass' | 'fail' | 'error' | 'timeout' | 'skipped' | 'unfixable'
  durationMs: number | null
  evidenceManifest: EvidenceManifest | null
  evidenceDirUri: string | null
  startedAt: string
  finishedAt: string | null
}

export interface E2eRunDetailResponse {
  run: E2eRunDTO
  sandbox: E2eSandboxDTO | null
  scenarioRuns: E2eScenarioRunDTO[]
}

export interface CreateRunBody {
  targetProjectId: string
  sourceBranch?: string
  scenarioFilter?: {
    ids?: string[]
    tags?: string[]
  }
  governorOverrides?: {
    maxPerScenarioAttempts?: number
    maxRunHours?: number
    maxTotalAttempts?: number
  }
}

export interface ScenarioOption {
  id: string
  name: string
  tags: string[]
  specPath: string
}

export interface ScenarioOptionsResponse {
  scenarios: ScenarioOption[]
  allTags: string[]
  ref: string
}

export const e2eRunsApi = {
  list: (params: { projectId?: string; limit?: number; offset?: number }) =>
    client.get<{ runs: E2eRunDTO[]; total: number }>('/e2e-runs', { params }).then(r => r.data),

  get: (runId: string) =>
    client.get<E2eRunDetailResponse>(`/e2e-runs/${runId}`).then(r => r.data),

  create: (body: CreateRunBody) =>
    client.post<{ runId: string; status: string }>('/e2e-runs', body).then(r => r.data),

  abort: (runId: string, reason?: string) =>
    client.post<{ ok: true }>(`/e2e-runs/${runId}/abort`, { reason }).then(r => r.data),

  listScenarioOptions: (projectId: string, ref?: string) =>
    client.get<ScenarioOptionsResponse>('/e2e-runs/scenario-options', {
      params: { projectId, ...(ref ? { ref } : {}) },
    }).then(r => r.data),
}
