import client from './client'
import type { PaginatedResponse } from './types'
import type { DingTalkUser, DingTalkUsersResponse } from '../types'

// Original function - preserved for backward compatibility (dropdowns, avatar maps)
// Wraps new paginated API with limit=100 and maps response back to legacy { users, total } shape
export const getDingTalkUsers = (keyword?: string): Promise<DingTalkUsersResponse> =>
  client.get<PaginatedResponse<DingTalkUser>>(
    '/dingtalk/users',
    { params: { ...(keyword ? { keyword } : {}), limit: 100 } }
  ).then(r => ({ users: r.data.data, total: r.data.total }))

// Paginated function for DingTalkUsersPage
export const getDingTalkUsersPaged = (
  params: { keyword?: string; page: number; limit: number },
  signal?: AbortSignal
): Promise<PaginatedResponse<DingTalkUser>> =>
  client.get<PaginatedResponse<DingTalkUser>>('/dingtalk/users', { params, signal }).then(r => r.data)

export const syncDingTalkUsers = () =>
  client.post<{ success: boolean; synced?: number; error?: string }>('/dingtalk/users/sync').then(r => r.data)
