import client from './client'

export interface ToolInfo {
  name: string
  description: string
  riskLevel: string
  defaultMinRole: string
}

export interface ToolPermission {
  id: number
  productLineId: number | null
  toolName: string
  minRole: string
}

export const getTools = () => client.get<ToolInfo[]>('/tools').then(r => r.data)

export const getToolPermissions = (productLineId: number) =>
  client.get<ToolPermission[]>('/tool-permissions', { params: { product_line_id: productLineId } }).then(r => r.data)

export const setToolPermissions = (productLineId: number, permissions: Array<{ toolName: string; minRole: string }>) =>
  client.put<ToolPermission[]>('/tool-permissions', { productLineId, permissions }).then(r => r.data)
