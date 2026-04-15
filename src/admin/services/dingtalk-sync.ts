import axios from 'axios'
import { getConfig } from '../../db/repositories/system-config.js'
import { upsertDingTalkUser } from '../../db/repositories/dingtalk-users.js'

interface DingTalkUserInfo {
  userid: string
  name: string
  avatar: string
  dept_id_list?: number[]
}

async function getAccessToken(): Promise<string> {
  const cfg = await getConfig('dingtalk')
  if (!cfg) throw new Error('DingTalk config not found in system_config. Set it via /admin/system-config/dingtalk first.')
  const { clientId, clientSecret } = cfg.value as { clientId: string; clientSecret: string }
  const res = await axios.post<{ accessToken: string; expireIn: number }>(
    'https://api.dingtalk.com/v1.0/oauth2/accessToken',
    { appKey: clientId, appSecret: clientSecret }
  )
  return res.data.accessToken
}

interface DingTalkApiError {
  errcode?: number
  errmsg?: string
  sub_code?: string
  sub_msg?: string
}

function ensureOk(data: DingTalkApiError, api: string): void {
  if (data.errcode && data.errcode !== 0) {
    const sub = data.sub_msg ? ` (${data.sub_code}: ${data.sub_msg})` : ''
    throw new Error(`DingTalk ${api} failed: errcode=${data.errcode} ${data.errmsg ?? ''}${sub}`)
  }
}

async function getDepartmentIds(token: string, parentId: number = 1): Promise<number[]> {
  const res = await axios.post<DingTalkApiError & { result?: { dept_id_list?: number[] } }>(
    'https://oapi.dingtalk.com/topapi/v2/department/listsubid',
    { dept_id: parentId },
    { params: { access_token: token } }
  )
  ensureOk(res.data, 'department/listsubid')
  const subIds = res.data.result?.dept_id_list ?? []
  const allIds = [parentId, ...subIds]
  for (const subId of subIds) {
    const nested = await getDepartmentIds(token, subId)
    allIds.push(...nested.filter(id => !allIds.includes(id)))
  }
  return allIds
}

async function getDepartmentUsers(token: string, deptId: number): Promise<DingTalkUserInfo[]> {
  const users: DingTalkUserInfo[] = []
  let cursor = 0
  let hasMore = true
  while (hasMore) {
    const res = await axios.post<DingTalkApiError & { result?: { list: DingTalkUserInfo[]; has_more: boolean; next_cursor: number } }>(
      'https://oapi.dingtalk.com/topapi/v2/user/list',
      { dept_id: deptId, cursor, size: 100 },
      { params: { access_token: token } }
    )
    ensureOk(res.data, 'user/list')
    const result = res.data.result
    if (result?.list) users.push(...result.list)
    hasMore = result?.has_more ?? false
    cursor = result?.next_cursor ?? 0
  }
  return users
}

export async function syncDingTalkUsers(): Promise<{ synced: number }> {
  const token = await getAccessToken()
  const deptIds = await getDepartmentIds(token)

  const seen = new Set<string>()
  let synced = 0

  for (const deptId of deptIds) {
    const users = await getDepartmentUsers(token, deptId)
    for (const user of users) {
      if (seen.has(user.userid)) continue
      seen.add(user.userid)
      await upsertDingTalkUser({
        userId: user.userid,
        name: user.name,
        avatar: user.avatar ?? '',
        department: String(user.dept_id_list?.[0] ?? ''),
      })
      synced++
    }
  }

  return { synced }
}
