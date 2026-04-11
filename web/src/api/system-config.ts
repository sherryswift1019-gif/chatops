import client from './client'
import type { SystemConfigEntry } from '../types'

export const getSystemConfig = () => client.get<SystemConfigEntry[]>('/system-config').then(r => r.data)
export const updateSystemConfig = (key: string, value: Record<string, unknown>) =>
  client.put<SystemConfigEntry>(`/system-config/${key}`, value).then(r => r.data)
