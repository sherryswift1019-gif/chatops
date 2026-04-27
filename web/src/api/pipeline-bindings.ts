import client from './client'

export interface PipelineBinding {
  productLineId: number
  refKey: string
  pipelineId: number
  serverRoleAssignments: Record<string, string[]>
  description: string
  createdAt: string
  updatedAt: string
}

export const listPipelineBindings = (filter?: { productLineId?: number; pipelineId?: number }) =>
  client.get<PipelineBinding[]>('/pipeline-bindings', { params: filter }).then(r => r.data)

export const getPipelineBinding = (productLineId: number, refKey: string) =>
  client.get<PipelineBinding>(`/pipeline-bindings/${productLineId}/${encodeURIComponent(refKey)}`).then(r => r.data)

export const upsertPipelineBinding = (b: Omit<PipelineBinding, 'createdAt' | 'updatedAt'>) =>
  client.post<PipelineBinding>('/pipeline-bindings', b).then(r => r.data)

export const deletePipelineBinding = (productLineId: number, refKey: string) =>
  client.delete(`/pipeline-bindings/${productLineId}/${encodeURIComponent(refKey)}`)
