import axios from 'axios'
import pLimit from 'p-limit'
import { getConfig } from '../../db/repositories/system-config.js'
import { upsertDingTalkUser } from '../../db/repositories/dingtalk-users.js'

interface DingTalkUserInfo {
  userid: string
  name: string
  avatar: string
  dept_id_list?: number[]
}

// user/get returns more fields than user/list — we only need email here.
// org_email = 企业邮箱（同步通讯录认证过的）；email = 个人邮箱（用户自填，可能空）。
// 优先 org_email，回退 email。
interface DingTalkUserDetail {
  userid: string
  org_email?: string
  email?: string
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

// 拉单个用户详情，仅为了拿 org_email/email。失败返回 null（不阻塞整个 sync）。
// user/list 不会返回 email 字段，所以必须这一步。
async function getUserEmail(token: string, userid: string): Promise<string | null> {
  try {
    const res = await axios.post<DingTalkApiError & { result?: DingTalkUserDetail }>(
      'https://oapi.dingtalk.com/topapi/v2/user/get',
      { userid, language: 'zh_CN' },
      { params: { access_token: token } }
    )
    ensureOk(res.data, 'user/get')
    const result = res.data.result
    const email = (result?.org_email || result?.email || '').trim()
    return email || null
  } catch (err) {
    console.warn(`[dingtalk-sync] user/get failed for ${userid}:`, err instanceof Error ? err.message : String(err))
    return null
  }
}

export async function syncDingTalkUsers(): Promise<{ synced: number; emails: number }> {
  const token = await getAccessToken()
  const deptIds = await getDepartmentIds(token)

  // 第一轮：列出所有部门下的用户（去重）
  const seen = new Map<string, DingTalkUserInfo>()
  for (const deptId of deptIds) {
    const users = await getDepartmentUsers(token, deptId)
    for (const user of users) {
      if (!seen.has(user.userid)) seen.set(user.userid, user)
    }
  }

  // 第二轮：逐人 user/get 拿 email，并发 5（钉钉 user/get QPS 上限 200，5 并发安全）
  // 单点失败不阻塞 sync——COALESCE 保留 DB 已有值
  const limit = pLimit(5)
  let emails = 0
  const upserts = Array.from(seen.values()).map((user) =>
    limit(async () => {
      const email = await getUserEmail(token, user.userid)
      if (email) emails++
      await upsertDingTalkUser({
        userId: user.userid,
        name: user.name,
        avatar: user.avatar ?? '',
        department: String(user.dept_id_list?.[0] ?? ''),
        email: email ?? undefined,
      })
    })
  )
  await Promise.all(upserts)

  return { synced: seen.size, emails }
}
