import client from './client'

export interface Capability {
  id: number
  key: string
  displayName: string
  description: string
  category: 'query' | 'action' | 'admin' | 'env_prep' | 'verify' | 'testing' | 'result'
  toolNames: string[]
  needsApproval: boolean
  paramSchema: Record<string, unknown>
  playbook: unknown[]
  isSystem: boolean
  updatedAt: string
  createdAt: string
}

export interface ProductLineCapability {
  id: number
  productLineId: number
  capabilityKey: string
  envName: string
  enabled: boolean
  allowedRoles: string[]
}

export const getCapabilities = () => client.get<Capability[]>('/capabilities').then(r => r.data)
export const createCapability = (body: Partial<Capability> & { key: string; displayName: string }) =>
  client.post<Capability>('/capabilities', body).then(r => r.data)
export const updateCapability = (id: number, body: Partial<Capability>) =>
  client.put<Capability>(`/capabilities/${id}`, body).then(r => r.data)

export const getProductLineCapabilities = (plId: number) =>
  client.get<ProductLineCapability[]>(`/product-lines/${plId}/capabilities`).then(r => r.data)
export const setProductLineCapabilities = (plId: number, caps: Array<{ capabilityKey: string; envName: string; enabled: boolean; allowedRoles: string[] }>) =>
  client.put<ProductLineCapability[]>(`/product-lines/${plId}/capabilities`, caps).then(r => r.data)

export interface StageOperation {
  id: number
  key: string
  displayName: string
  description: string
  category: string
  toolNames: string[]
  paramSchema: Record<string, unknown>
  playbook: unknown[]
  createdAt: string
}

export const getStageOperations = () =>
  client.get<StageOperation[]>('/stage-operations').then(r => r.data)
