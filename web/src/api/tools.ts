import client from './client'

export interface ToolMeta {
  name: string
  description: string
  riskLevel: 'low' | 'medium' | 'high'
  requiredRole: string | null
  defaultRoles: string[] | null
}

export async function listTools(): Promise<ToolMeta[]> {
  const r = await client.get<ToolMeta[]>('/tools')
  return r.data
}
