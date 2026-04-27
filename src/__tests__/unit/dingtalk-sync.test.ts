/**
 * Unit test: dingtalk-sync 拉 user/get 拿 email 的回填路径。
 *
 * 背景：schema-v28 把 dingtalk_users.email 加进表，但旧 sync 代码只调 user/list
 * （user/list 不返回 email），导致 prd_submit step 4 反查 email 永远空。
 * 本文件专门测：
 *   1. user/list 列出用户后，对每人调 user/get 拿 org_email/email，传入 upsert
 *   2. user/get 失败（错误码 / 网络错）时不阻塞整体 sync，该 user 以 email=undefined upsert
 *   3. user/get 返回空 email 时 upsert 拿到 undefined（COALESCE 保留 DB 已有值）
 *   4. 返回值里 emails 计数等于实际拿到 email 的人数
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('axios', () => ({
  default: { post: vi.fn() },
}))

vi.mock('../../db/repositories/system-config.js', () => ({
  getConfig: vi.fn(async () => ({
    value: { clientId: 'fake-key', clientSecret: 'fake-secret' },
  })),
}))

vi.mock('../../db/repositories/dingtalk-users.js', () => ({
  upsertDingTalkUser: vi.fn(async () => {}),
}))

import axios from 'axios'
import { syncDingTalkUsers } from '../../admin/services/dingtalk-sync.js'
import { upsertDingTalkUser } from '../../db/repositories/dingtalk-users.js'

const post = axios.post as unknown as ReturnType<typeof vi.fn>
const upsert = upsertDingTalkUser as unknown as ReturnType<typeof vi.fn>

// 把每个 DingTalk endpoint 的 mock response 集中编织成一个 router，
// 避免在每个 test 里手写 mockImplementationOnce 链条（顺序敏感，易脆）
type EmailMap = Record<string, { org_email?: string; email?: string } | 'fail'>

function setupDingTalkMocks(opts: {
  /** 部门 1 下的用户（只填 userid + name，简化） */
  users: Array<{ userid: string; name: string }>
  /** userid → user/get 返回的 email 字段（'fail' 表示这次 user/get 抛/errcode） */
  emails: EmailMap
}): void {
  post.mockReset()
  post.mockImplementation(async (url: string, body: Record<string, unknown>) => {
    if (url.includes('oauth2/accessToken')) {
      return { data: { accessToken: 'tok-fake', expireIn: 7200 } }
    }
    if (url.endsWith('department/get')) {
      return { data: { errcode: 0, result: { dept_id: 1, name: '根部门', parent_id: 0 } } }
    }
    if (url.endsWith('department/listsub')) {
      // 没子部门，递归终止
      return { data: { errcode: 0, result: [] } }
    }
    if (url.endsWith('user/list')) {
      return {
        data: {
          errcode: 0,
          result: {
            list: opts.users.map((u) => ({ userid: u.userid, name: u.name, avatar: '', dept_id_list: [1] })),
            has_more: false,
            next_cursor: 0,
          },
        },
      }
    }
    if (url.endsWith('user/get')) {
      const userid = body.userid as string
      const e = opts.emails[userid]
      if (e === 'fail') throw new Error('boom')
      return {
        data: {
          errcode: 0,
          result: { userid, ...(e ?? {}) },
        },
      }
    }
    throw new Error(`unexpected url: ${url}`)
  })
}

describe('syncDingTalkUsers', () => {
  beforeEach(() => {
    upsert.mockClear()
  })

  it('回填 org_email：user/get 返回 org_email → upsert 收到 email 字符串', async () => {
    setupDingTalkMocks({
      users: [{ userid: 'u-1', name: 'Alice' }],
      emails: { 'u-1': { org_email: 'alice@example.com' } },
    })

    const result = await syncDingTalkUsers()

    expect(result.synced).toBe(1)
    expect(result.emails).toBe(1)
    expect(upsert).toHaveBeenCalledTimes(1)
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u-1', email: 'alice@example.com' }),
    )
  })

  it('优先 org_email：org_email 和 email 同时存在时取 org_email', async () => {
    setupDingTalkMocks({
      users: [{ userid: 'u-2', name: 'Bob' }],
      emails: { 'u-2': { org_email: 'bob@corp.com', email: 'bob@personal.com' } },
    })

    await syncDingTalkUsers()

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u-2', email: 'bob@corp.com' }),
    )
  })

  it('回退 email：org_email 缺失但 email 存在 → 用 email', async () => {
    setupDingTalkMocks({
      users: [{ userid: 'u-3', name: 'Carol' }],
      emails: { 'u-3': { email: 'carol@personal.com' } },
    })

    await syncDingTalkUsers()

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u-3', email: 'carol@personal.com' }),
    )
  })

  it('user/get 失败：单点降级，不阻塞其他用户；失败者 upsert 拿到 email=undefined', async () => {
    setupDingTalkMocks({
      users: [
        { userid: 'u-good', name: 'Good' },
        { userid: 'u-bad', name: 'Bad' },
      ],
      emails: {
        'u-good': { org_email: 'good@example.com' },
        'u-bad': 'fail',
      },
    })

    const result = await syncDingTalkUsers()

    expect(result.synced).toBe(2)
    expect(result.emails).toBe(1) // 只 good 拿到了
    expect(upsert).toHaveBeenCalledTimes(2)
    // 失败者 email 走 undefined 分支（upsert SQL 里转 null + COALESCE 保留 DB 既有）
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u-bad', email: undefined }),
    )
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u-good', email: 'good@example.com' }),
    )
  })

  it('user/get 返回空 email：upsert 拿到 email=undefined（不写 NULL，靠 COALESCE 保留旧值）', async () => {
    setupDingTalkMocks({
      users: [{ userid: 'u-empty', name: 'Empty' }],
      emails: { 'u-empty': {} }, // 没 org_email 也没 email
    })

    const result = await syncDingTalkUsers()

    expect(result.emails).toBe(0)
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u-empty', email: undefined }),
    )
  })

  it('user/list 部门遍历跨部门去重：同一 userid 在多部门下只 upsert 一次', async () => {
    // 这里覆盖 sync 内部 seen Map 的去重路径——
    // 通过让 listsubid 返回多个子部门并让同一 user 出现多次实现
    post.mockReset()
    post.mockImplementation(async (url: string, body: Record<string, unknown>) => {
      if (url.includes('oauth2/accessToken')) {
        return { data: { accessToken: 'tok-fake' } }
      }
      if (url.endsWith('department/get')) {
        const deptId = body.dept_id as number
        const names: Record<number, string> = { 1: '根部门', 2: 'Dept2', 3: 'Dept3' }
        return { data: { errcode: 0, result: { dept_id: deptId, name: names[deptId] ?? `Dept${deptId}`, parent_id: deptId === 1 ? 0 : 1 } } }
      }
      if (url.endsWith('department/listsub')) {
        const parent = body.dept_id as number
        // 根部门 1 下挂两个子部门 2, 3；2、3 都没子
        if (parent === 1) return { data: { errcode: 0, result: [
          { dept_id: 2, name: 'Dept2', parent_id: 1 },
          { dept_id: 3, name: 'Dept3', parent_id: 1 },
        ] } }
        return { data: { errcode: 0, result: [] } }
      }
      if (url.endsWith('user/list')) {
        // 让 dup 用户在部门 2 和 3 都返回；solo 仅在部门 3
        const deptId = body.dept_id as number
        const list =
          deptId === 2
            ? [{ userid: 'dup', name: 'Dup', avatar: '', dept_id_list: [2] }]
            : deptId === 3
              ? [
                  { userid: 'dup', name: 'Dup', avatar: '', dept_id_list: [3] },
                  { userid: 'solo', name: 'Solo', avatar: '', dept_id_list: [3] },
                ]
              : []
        return {
          data: { errcode: 0, result: { list, has_more: false, next_cursor: 0 } },
        }
      }
      if (url.endsWith('user/get')) {
        const userid = body.userid as string
        return {
          data: {
            errcode: 0,
            result: { userid, org_email: `${userid}@example.com` },
          },
        }
      }
      throw new Error(`unexpected url: ${url}`)
    })

    const result = await syncDingTalkUsers()

    expect(result.synced).toBe(2) // dup + solo，dup 不重复算
    const userIds = upsert.mock.calls.map((c) => (c[0] as { userId: string }).userId).sort()
    expect(userIds).toEqual(['dup', 'solo'])
  })
})
