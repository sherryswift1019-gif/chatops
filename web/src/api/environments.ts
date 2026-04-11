import client from './client'
import type { Environment } from '../types'

export const getEnvironments = () => client.get<Environment[]>('/environments').then(r => r.data)
export const createEnvironment = (body: { name: string; displayName: string; sortOrder?: number }) =>
  client.post<Environment>('/environments', body).then(r => r.data)
export const updateEnvironment = (id: number, body: Partial<Environment>) =>
  client.put<Environment>(`/environments/${id}`, body).then(r => r.data)
export const deleteEnvironment = (id: number) => client.delete(`/environments/${id}`)
