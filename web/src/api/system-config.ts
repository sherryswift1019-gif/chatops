import client from './client'
import type { SystemConfigEntry } from '../types'

export const getSystemConfig = () => client.get<SystemConfigEntry[]>('/system-config').then(r => r.data)
export const updateSystemConfig = (key: string, value: Record<string, unknown>) =>
  client.put<SystemConfigEntry>(`/system-config/${key}`, value).then(r => r.data)
export const exportSystemConfig = () =>
  client.get<Array<{ key: string; value: Record<string, unknown> }>>('/system-config/export').then(r => r.data)
export const importSystemConfig = (data: Array<{ key: string; value: Record<string, unknown> }>) =>
  client.post<{ success: boolean; imported: number }>('/system-config/import', data).then(r => r.data)
