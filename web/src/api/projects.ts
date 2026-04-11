import client from './client'
import type { Project } from '../types'

export const getProjects = (productLineId?: number) =>
  client.get<Project[]>('/projects', { params: productLineId ? { product_line_id: productLineId } : {} }).then(r => r.data)
export const createProject = (body: Partial<Project> & { productLineId: number; name: string; displayName: string }) =>
  client.post<Project>('/projects', body).then(r => r.data)
export const updateProject = (id: number, body: Partial<Project>) =>
  client.put<Project>(`/projects/${id}`, body).then(r => r.data)
export const deleteProject = (id: number) => client.delete(`/projects/${id}`)
