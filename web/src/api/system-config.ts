import client from './client'
import type { SystemConfigEntry, DingTalkStatus, ConnectionTestResult } from '../types'

export const getSystemConfig = () => client.get<SystemConfigEntry[]>('/system-config').then(r => r.data)
export const updateSystemConfig = (key: string, value: Record<string, unknown>) =>
  client.put<SystemConfigEntry>(`/system-config/${key}`, value).then(r => r.data)
export const exportAllData = () =>
  client.get<Record<string, unknown>>('/export').then(r => r.data)
export const importAllData = (data: Record<string, unknown>) =>
  client.post<{ success: boolean; stats: Record<string, number> }>('/import', data).then(r => r.data)

export const getDingTalkStatus = () =>
  client.get<DingTalkStatus>('/system-config/dingtalk/status').then(r => r.data)
export const testGitLabConnection = () =>
  client.post<ConnectionTestResult>('/system-config/gitlab/test').then(r => r.data)
export const testHarborConnection = () =>
  client.post<ConnectionTestResult>('/system-config/harbor/test').then(r => r.data)
