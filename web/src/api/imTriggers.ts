import client from './client'
import type { IMTrigger, ProductLineIMTrigger, SetIMTriggerInput } from '../types/imTrigger'

export async function listIMTriggers(): Promise<IMTrigger[]> {
  const { data } = await client.get<IMTrigger[]>('/im-triggers')
  return data
}

export async function getIMTrigger(key: string): Promise<IMTrigger> {
  const { data } = await client.get<IMTrigger>(`/im-triggers/${key}`)
  return data
}

export async function createIMTrigger(input: Partial<IMTrigger>): Promise<IMTrigger> {
  const { data } = await client.post<IMTrigger>('/im-triggers', input)
  return data
}

export async function updateIMTrigger(id: number, patch: Partial<IMTrigger>): Promise<IMTrigger> {
  const { data } = await client.put<IMTrigger>(`/im-triggers/${id}`, patch)
  return data
}

export async function deleteIMTrigger(id: number): Promise<void> {
  await client.delete(`/im-triggers/${id}`)
}

export async function listProductLineIMTriggers(productLineId: number): Promise<ProductLineIMTrigger[]> {
  const { data } = await client.get<ProductLineIMTrigger[]>(`/product-lines/${productLineId}/im-triggers`)
  return data
}

export async function setProductLineIMTriggers(productLineId: number, items: SetIMTriggerInput[]): Promise<void> {
  await client.put(`/product-lines/${productLineId}/im-triggers`, { items })
}
