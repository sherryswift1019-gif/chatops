import client from './client'
import type { PaginatedResponse } from './types'
import type { DingTalkUser, DingTalkUsersResponse } from '../types'

export interface UserReferenceEntry {
  table: string
  label: string
  count: number
}

export interface UserReferenceResult {
  blocked: boolean
  references: UserReferenceEntry[]
}

// 下拉组件专用：仅返回在职用户，保持原有接口形状
export const getDingTalkUsers = (keyword?: string): Promise<DingTalkUsersResponse> =>
  client.get<PaginatedResponse<DingTalkUser>>(
    '/dingtalk/users',
    { params: { ...(keyword ? { keyword } : {}), limit: 100, status: 'active' } }
  ).then(r => ({ users: r.data.data, total: r.data.total }))

// 列表页分页（支持 status 过滤）
export const getDingTalkUsersPaged = (
  params: { keyword?: string; page: number; limit: number; status?: 'all' | 'active' | 'resigned' },
  signal?: AbortSignal
): Promise<PaginatedResponse<DingTalkUser>> =>
  client.get<PaginatedResponse<DingTalkUser>>('/dingtalk/users', { params, signal }).then(r => r.data)

export const syncDingTalkUsers = () =>
  client.post<{ success: boolean; synced?: number; resigned?: number; rejoined?: number; error?: string }>(
    '/dingtalk/users/sync'
  ).then(r => r.data)

export const getUserReferences = (userId: string): Promise<UserReferenceResult> =>
  client.get<UserReferenceResult>(`/dingtalk/users/${encodeURIComponent(userId)}/references`).then(r => r.data)

export const deleteUser = (userId: string): Promise<{ success: boolean }> =>
  client.delete<{ success: boolean }>(`/dingtalk/users/${encodeURIComponent(userId)}`).then(r => r.data)
