import client from './client'
import type { DingTalkUsersResponse } from '../types'

export const getDingTalkUsers = (keyword?: string) =>
  client.get<DingTalkUsersResponse>('/dingtalk/users', { params: keyword ? { keyword } : {} }).then(r => r.data)
export const syncDingTalkUsers = () =>
  client.post<{ success: boolean; synced?: number; error?: string }>('/dingtalk/users/sync').then(r => r.data)
