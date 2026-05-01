// web/src/api/e2e.ts
import axios from 'axios'

export interface E2eTargetProject {
  id: string
  displayName: string
  gitlabRepo: string
  defaultBranch: string
  workingDir: string
  scripts: { build: string; deploy: string; test: string; fix?: string }
  capabilities: Record<string, unknown>
  defaultSandboxKind: string
  createdAt: string
}

export type GenerationStatus =
  | 'pending' | 'generating' | 'pr_open' | 'committed'
  | 'baseline_failed' | 'blocked_on_baseline_bug' | 'skipped'

export interface E2eSpec {
  id: string
  targetProjectId: string
  specPath: string
  title: string
  contentHash: string
  generatedArtifactPath: string | null
  generatedPrUrl: string | null
  generationStatus: GenerationStatus
  lastGeneratedAt: string | null
  createdAt: string
}

export const e2eApi = {
  listTargets: () => axios.get<E2eTargetProject[]>('/admin/e2e-targets').then(r => r.data),
  getTarget: (id: string) => axios.get<E2eTargetProject>(`/admin/e2e-targets/${id}`).then(r => r.data),
  updateTarget: (
    id: string,
    body: Partial<Pick<E2eTargetProject, 'displayName' | 'gitlabRepo' | 'defaultBranch' | 'workingDir' | 'scripts' | 'defaultSandboxKind'>>,
  ) => axios.put<E2eTargetProject>(`/admin/e2e-targets/${id}`, body).then(r => r.data),
  getGitlabBaseUrl: () =>
    axios.get<{ url: string | null }>('/admin/e2e-targets-gitlab-base-url').then(r => r.data),
  testRepo: (gitlabRepo: string) =>
    axios.post<{ ok: boolean; message: string }>('/admin/e2e-targets/test-repo', { gitlabRepo }).then(r => r.data),

  listSpecs: (projectId = 'chatops') =>
    axios.get<E2eSpec[]>('/admin/e2e-specs', { params: { projectId } }).then(r => r.data),

  createSpec: (data: { targetProjectId: string; specPath: string; title: string }) =>
    axios.post<E2eSpec>('/admin/e2e-specs', data).then(r => r.data),

  generateSpec: (id: string) =>
    axios.post<{ message: string; specId: string }>(`/admin/e2e-specs/${id}/generate`).then(r => r.data),

  skipSpec: (id: string) =>
    axios.put<E2eSpec>(`/admin/e2e-specs/${id}`, { skip: true }).then(r => r.data),
}
