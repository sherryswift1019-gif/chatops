import client from './client'
import type { ProductLine, ProductLineMember, ProductLineEnv } from '../types'

export const getProductLines = () => client.get<ProductLine[]>('/product-lines').then(r => r.data)
export const createProductLine = (body: { name: string; displayName: string; description?: string }) =>
  client.post<ProductLine>('/product-lines', body).then(r => r.data)
export const updateProductLine = (id: number, body: Partial<ProductLine>) =>
  client.put<ProductLine>(`/product-lines/${id}`, body).then(r => r.data)
export const deleteProductLine = (id: number) => client.delete(`/product-lines/${id}`)

export const getMembers = (plId: number) =>
  client.get<ProductLineMember[]>(`/product-lines/${plId}/members`).then(r => r.data)
export const addMember = (plId: number, body: { userId: string; userName: string; role: string }) =>
  client.post<ProductLineMember>(`/product-lines/${plId}/members`, body).then(r => r.data)
export const updateMemberRole = (plId: number, memberId: number, role: string) =>
  client.put<ProductLineMember>(`/product-lines/${plId}/members/${memberId}`, { role }).then(r => r.data)
export const removeMember = (plId: number, memberId: number) =>
  client.delete(`/product-lines/${plId}/members/${memberId}`)

export const getProductLineEnvs = (plId: number) =>
  client.get<ProductLineEnv[]>(`/product-lines/${plId}/envs`).then(r => r.data)
export const setProductLineEnvs = (plId: number, envs: Array<{ envId: number; runtime: string; namespace?: string; enabled?: boolean }>) =>
  client.put<ProductLineEnv[]>(`/product-lines/${plId}/envs`, envs).then(r => r.data)
