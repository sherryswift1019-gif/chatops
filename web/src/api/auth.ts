import client from './client'

export interface MeResponse {
  username: string
  mustChangePassword: boolean
}

export async function login(username: string, password: string): Promise<MeResponse> {
  const res = await client.post<MeResponse>('/auth/login', { username, password })
  return res.data
}

export async function logout(): Promise<void> {
  await client.post('/auth/logout')
}

export async function me(): Promise<MeResponse> {
  const res = await client.get<MeResponse>('/auth/me')
  return res.data
}

export async function changePassword(oldPassword: string, newPassword: string): Promise<void> {
  await client.post('/auth/change-password', { oldPassword, newPassword })
}
