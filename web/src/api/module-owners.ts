import client from './client'
import type { ModuleOwner } from '../types'

export const getModuleOwners = (productLineId: number) =>
  client.get<{ data: ModuleOwner[] }>('/module-owners', { params: { product_line_id: productLineId } }).then(r => r.data.data)

export const createModuleOwner = (body: { productLineId: number; modulePattern: string; ownerUserId: string; backupOwnerUserId?: string }) =>
  client.post<{ data: ModuleOwner }>('/module-owners', body).then(r => r.data.data)

export const deleteModuleOwner = (id: number) =>
  client.delete(`/module-owners/${id}`).then(r => r.data)
