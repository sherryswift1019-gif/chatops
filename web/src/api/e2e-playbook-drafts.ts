// web/src/api/e2e-playbook-drafts.ts
import axios from 'axios'

export type DraftStatus = 'drafting' | 'reviewing' | 'approved' | 'rejected' | 'generation_failed'

export interface E2ePlaybookDraft {
  id: string  // bigint stringified
  targetProjectId: string
  scenarioInput: string
  yamlContent: string | null
  status: DraftStatus
  e2eRunId: string | null
  errorMessage: string | null
  createdAt: string
  updatedAt: string
}

export const e2ePlaybookDraftsApi = {
  create: (body: { targetProjectId: string; scenarioInput: string }) =>
    axios.post<{ draftId: string }>('/admin/e2e-playbook-drafts', body).then(r => r.data),
  get: (id: string) =>
    axios.get<E2ePlaybookDraft>(`/admin/e2e-playbook-drafts/${id}`).then(r => r.data),
  updateYaml: (id: string, yamlContent: string) =>
    axios.put(`/admin/e2e-playbook-drafts/${id}`, { yamlContent }).then(r => r.data),
  regenerate: (id: string) =>
    axios.post(`/admin/e2e-playbook-drafts/${id}/regenerate`).then(r => r.data),
  reject: (id: string) =>
    axios.post(`/admin/e2e-playbook-drafts/${id}/reject`).then(r => r.data),
}

// SSE 用 EventSource，不走 axios。导出工具函数：
export function openDraftStream(
  draftId: string,
  callbacks: {
    onChunk?: (text: string) => void
    onDone?: () => void
    onError?: (msg: string) => void
  },
): EventSource {
  const es = new EventSource(`/admin/e2e-playbook-drafts/${draftId}/stream`)
  es.onmessage = (e) => {
    try {
      const ev = JSON.parse(e.data) as { type: string; text?: string; message?: string }
      if (ev.type === 'chunk') callbacks.onChunk?.(ev.text ?? '')
      else if (ev.type === 'done') { callbacks.onDone?.(); es.close() }
      else if (ev.type === 'error') { callbacks.onError?.(ev.message ?? 'unknown'); es.close() }
    } catch { /* ignore parse error */ }
  }
  es.onerror = () => { callbacks.onError?.('stream connection lost'); es.close() }
  return es
}
