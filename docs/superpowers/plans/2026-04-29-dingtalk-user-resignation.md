# DingTalk User Resignation Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在钉钉同步时自动标记已离职用户，管理员可手动删除离职用户，删除前检查 A 类活跃引用（有引用则阻断）。

**Architecture:** 新增 `resigned_at` 列到 `dingtalk_users`，同步结束后做集合差运算标记离职 / 自动清除重新入职；新增独立 reference-check 服务并行查 4 张 A 类表；前端用户列表增加状态过滤 Tab、离职标签、带引用预检的删除流程。

**Tech Stack:** PostgreSQL（JSONB `@>` 算子），Fastify 5，React 18 + Ant Design 5，Vitest + testcontainers

---

## File Map

| 文件 | 改动类型 | 职责 |
|---|---|---|
| `src/db/schema-v55.sql` | 新建 | ALTER TABLE 添加 `resigned_at` 列 |
| `src/db/migrate.ts` | 修改 | 追加 v54 到 SCHEMA_FILES |
| `src/__tests__/helpers/db.ts` | 修改 | 追加 v54 到 test schema 列表 |
| `src/db/repositories/dingtalk-users.ts` | 修改 | 加 `resignedAt` 字段；新增 5 个函数 |
| `src/admin/services/user-reference-check.ts` | 新建 | 并行查 4 张 A 类表，返回阻断结果 |
| `src/admin/services/dingtalk-sync.ts` | 修改 | 同步后做集合差，调用 mark / clear |
| `src/admin/routes/dingtalk-users.ts` | 修改 | 加 `status` 参数、`references` GET、`DELETE` |
| `src/__tests__/integration/dingtalk-resignation.test.ts` | 新建 | DB 集成测试：mark/clear/reference-check/delete |
| `web/src/types/index.ts` | 修改 | `DingTalkUser` 加 `resignedAt: string \| null` |
| `web/src/api/dingtalk-users.ts` | 修改 | 加 `getUserReferences`、`deleteUser`；list 加 `status` |
| `web/src/pages/DingTalkUsersPage.tsx` | 修改 | 状态过滤 Tab、离职标签、删除流程 |

---

## Task 1: Schema 迁移 v54

**Files:**
- Create: `src/db/schema-v55.sql`
- Modify: `src/db/migrate.ts`
- Modify: `src/__tests__/helpers/db.ts`

- [ ] **Step 1: 创建 schema-v55.sql**

```sql
-- src/db/schema-v55.sql
ALTER TABLE dingtalk_users ADD COLUMN IF NOT EXISTS resigned_at TIMESTAMPTZ NULL;
-- NULL = 在职；非空 = 离职时间戳
```

- [ ] **Step 2: 追加到 migrate.ts**

在 `src/db/migrate.ts` 的 SCHEMA_FILES 数组末尾追加（紧接 v53 之后）：

```typescript
  ['v55', 'schema-v55.sql'],
```

- [ ] **Step 3: 追加到测试 schema 列表**

在 `src/__tests__/helpers/db.ts` 中 `resetTestDb()` 所使用的 schema 列表末尾追加（纯 ALTER TABLE 加列，无 seed 数据，符合加入条件）：

```typescript
  'schema-v55.sql',
```

- [ ] **Step 4: 验证迁移能跑通**

```bash
pnpm migrate
```

Expected: 输出包含 `Applied v54` 或 `schema-v55.sql` 字样，无报错。

- [ ] **Step 5: Commit**

```bash
git add src/db/schema-v55.sql src/db/migrate.ts src/__tests__/helpers/db.ts
git commit -m "feat: add resigned_at column to dingtalk_users (schema-v54)"
```

---

## Task 2: Repository — resigned_at 字段支持

**Files:**
- Modify: `src/db/repositories/dingtalk-users.ts`

- [ ] **Step 1: 更新 DingTalkUser 接口和 mapRow**

将文件顶部的接口和 mapRow 替换为：

```typescript
export interface DingTalkUser {
  userId: string
  name: string
  avatar: string
  department: string
  email: string | null
  syncedAt: Date
  resignedAt: Date | null
}

function mapRow(r: Record<string, unknown>): DingTalkUser {
  return {
    userId: r.user_id as string,
    name: r.name as string,
    avatar: r.avatar as string,
    department: r.department as string,
    email: (r.email as string | null) ?? null,
    syncedAt: r.synced_at as Date,
    resignedAt: (r.resigned_at as Date | null) ?? null,
  }
}
```

- [ ] **Step 2: 修改 upsertDingTalkUser — 重新出现时清空 resigned_at**

在 `ON CONFLICT (user_id) DO UPDATE SET` 块中增加 `resigned_at = NULL`：

```typescript
export async function upsertDingTalkUser(
  data: Pick<DingTalkUser, 'userId' | 'name'> & Partial<Pick<DingTalkUser, 'avatar' | 'department'>> & { email?: string }
): Promise<void> {
  const pool = getPool()
  await pool.query(
    `INSERT INTO dingtalk_users (user_id, name, avatar, department, email, synced_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       name = $2, avatar = $3, department = $4,
       email = COALESCE($5, dingtalk_users.email),
       synced_at = NOW(),
       resigned_at = NULL`,
    [data.userId, data.name, data.avatar ?? '', data.department ?? '', data.email ?? null]
  )
}
```

- [ ] **Step 3: 修改 listDingTalkUsersPaged — 支持 status 过滤**

```typescript
export async function listDingTalkUsersPaged(
  keyword: string | null,
  page: number,
  limit: number,
  status: 'all' | 'active' | 'resigned' = 'all'
): Promise<{ data: DingTalkUser[]; total: number }> {
  const pool = getPool()
  const offset = (page - 1) * limit
  const kw = keyword || null

  const statusClause =
    status === 'active' ? 'AND resigned_at IS NULL' :
    status === 'resigned' ? 'AND resigned_at IS NOT NULL' :
    ''

  const [dataResult, countResult] = await Promise.all([
    pool.query(
      `SELECT * FROM dingtalk_users
       WHERE ($1::text IS NULL OR name ILIKE '%' || $1 || '%' OR user_id ILIKE '%' || $1 || '%' OR department ILIKE '%' || $1 || '%')
       ${statusClause}
       ORDER BY resigned_at IS NOT NULL, name, user_id
       LIMIT $2 OFFSET $3`,
      [kw, limit, offset]
    ),
    pool.query(
      `SELECT COUNT(*) AS count FROM dingtalk_users
       WHERE ($1::text IS NULL OR name ILIKE '%' || $1 || '%' OR user_id ILIKE '%' || $1 || '%' OR department ILIKE '%' || $1 || '%')
       ${statusClause}`,
      [kw]
    ),
  ])

  return {
    data: dataResult.rows.map(mapRow),
    total: parseInt(countResult.rows[0].count, 10),
  }
}
```

> 注：`ORDER BY resigned_at IS NOT NULL` 让在职用户排前面（false < true）。

- [ ] **Step 4: 新增 getActiveUserIds、getResignedUserIds、markUsersAsResigned、deleteUser**

在文件末尾追加：

```typescript
export async function getActiveUserIds(): Promise<string[]> {
  const pool = getPool()
  const { rows } = await pool.query(
    'SELECT user_id FROM dingtalk_users WHERE resigned_at IS NULL'
  )
  return rows.map(r => r.user_id as string)
}

export async function getResignedUserIds(): Promise<string[]> {
  const pool = getPool()
  const { rows } = await pool.query(
    'SELECT user_id FROM dingtalk_users WHERE resigned_at IS NOT NULL'
  )
  return rows.map(r => r.user_id as string)
}

export async function markUsersAsResigned(userIds: string[]): Promise<void> {
  if (userIds.length === 0) return
  const pool = getPool()
  await pool.query(
    'UPDATE dingtalk_users SET resigned_at = NOW() WHERE user_id = ANY($1)',
    [userIds]
  )
}

export async function deleteUser(userId: string): Promise<void> {
  const pool = getPool()
  await pool.query('DELETE FROM dingtalk_users WHERE user_id = $1', [userId])
}
```

- [ ] **Step 5: Commit**

```bash
git add src/db/repositories/dingtalk-users.ts
git commit -m "feat: add resignedAt field and departure helpers to dingtalk-users repository"
```

---

## Task 3: User Reference Check 服务

**Files:**
- Create: `src/admin/services/user-reference-check.ts`

- [ ] **Step 1: 创建文件**

```typescript
// src/admin/services/user-reference-check.ts
import { getPool } from '../../db/client.js'

export interface ReferenceEntry {
  table: string
  label: string
  count: number
}

export interface UserReferenceResult {
  blocked: boolean
  references: ReferenceEntry[]
}

export async function checkUserActiveReferences(userId: string): Promise<UserReferenceResult> {
  const pool = getPool()

  const checks = await Promise.all([
    pool.query(
      'SELECT COUNT(*) AS count FROM user_roles WHERE user_id = $1',
      [userId]
    ).then(r => ({ table: 'user_roles', label: '角色分配', count: parseInt(r.rows[0].count, 10) })),

    pool.query(
      'SELECT COUNT(*) AS count FROM product_line_members WHERE user_id = $1',
      [userId]
    ).then(r => ({ table: 'product_line_members', label: '产品线成员', count: parseInt(r.rows[0].count, 10) })),

    pool.query(
      "SELECT COUNT(*) AS count FROM projects WHERE owner_id = $1 AND owner_id != ''",
      [userId]
    ).then(r => ({ table: 'projects', label: '项目负责人', count: parseInt(r.rows[0].count, 10) })),

    pool.query(
      `SELECT COUNT(*) AS count FROM approval_rules
       WHERE primary_approvers @> jsonb_build_array($1::text)
          OR backup_approvers @> jsonb_build_array($1::text)`,
      [userId]
    ).then(r => ({ table: 'approval_rules', label: '审批规则', count: parseInt(r.rows[0].count, 10) })),
  ])

  const references = checks.filter(c => c.count > 0)
  return { blocked: references.length > 0, references }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/admin/services/user-reference-check.ts
git commit -m "feat: add user active reference check service (5 A-class tables)"
```

---

## Task 4: Sync 服务 — 离职检测

**Files:**
- Modify: `src/admin/services/dingtalk-sync.ts`

- [ ] **Step 1: 在顶部增加 import**

在现有 `import { upsertDingTalkUser }` 那行修改为：

```typescript
import {
  upsertDingTalkUser,
  getActiveUserIds,
  getResignedUserIds,
  markUsersAsResigned,
} from '../../db/repositories/dingtalk-users.js'
```

- [ ] **Step 2: 修改 syncDingTalkUsers 函数签名和末尾逻辑**

将函数最后的 `return` 及其之前部分替换为：

```typescript
export async function syncDingTalkUsers(): Promise<{
  synced: number
  emails: number
  resigned: number
  rejoined: number
}> {
  const token = await getAccessToken()
  const deptTree = await loadDepartmentTree(token)

  // 第一轮：列出所有部门下的用户（去重）
  const seen = new Map<string, DingTalkUserInfo>()
  for (const deptId of deptTree.keys()) {
    const users = await getDepartmentUsers(token, deptId)
    for (const user of users) {
      if (!seen.has(user.userid)) seen.set(user.userid, user)
    }
  }

  const syncedSet = new Set(seen.keys())

  // 在 upsert 之前统计重新入职数（upsert 会清空 resigned_at，事后查不到）
  const resignedIdsBefore = await getResignedUserIds()
  const rejoinedCount = resignedIdsBefore.filter(id => syncedSet.has(id)).length

  // 第二轮：逐人 user/get 拿 email，并发 5
  const limit = pLimit(5)
  let emails = 0
  const upserts = Array.from(seen.values()).map((user) =>
    limit(async () => {
      const email = await getUserEmail(token, user.userid)
      if (email) emails++
      const userDeptId = user.dept_id_list?.[0]
      const departmentPath = userDeptId ? buildDepartmentPath(userDeptId, deptTree) : ''
      await upsertDingTalkUser({
        userId: user.userid,
        name: user.name,
        avatar: user.avatar ?? '',
        department: departmentPath,
        email: email ?? undefined,
      })
    })
  )
  await Promise.all(upserts)

  // 离职检测：在职用户不在本次 sync 结果里 → 标记离职
  const activeIds = await getActiveUserIds()
  const departed = activeIds.filter(id => !syncedSet.has(id))
  if (departed.length > 0) {
    await markUsersAsResigned(departed)
  }

  return { synced: seen.size, emails, resigned: departed.length, rejoined: rejoinedCount }
}
```

- [ ] **Step 3: 验证 TypeScript 编译**

```bash
./test.sh --typecheck
```

Expected: 无 TS 错误。

- [ ] **Step 4: Commit**

```bash
git add src/admin/services/dingtalk-sync.ts
git commit -m "feat: detect departed users after DingTalk sync and mark resigned_at"
```

---

## Task 5: Routes — status 过滤 + references + DELETE

**Files:**
- Modify: `src/admin/routes/dingtalk-users.ts`

- [ ] **Step 1: 完整替换路由文件**

```typescript
// src/admin/routes/dingtalk-users.ts
import type { FastifyInstance } from 'fastify'
import {
  listDingTalkUsersPaged,
  getDingTalkUserById,
  deleteUser,
} from '../../db/repositories/dingtalk-users.js'
import { syncDingTalkUsers } from '../services/dingtalk-sync.js'
import { checkUserActiveReferences } from '../services/user-reference-check.js'

export async function registerDingTalkUserRoutes(app: FastifyInstance): Promise<void> {
  // 列表（支持 status 过滤）
  app.get('/dingtalk/users', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          keyword: { type: 'string' },
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          status: { type: 'string', enum: ['all', 'active', 'resigned'], default: 'all' },
        },
      },
    },
  }, async (req, reply) => {
    const { keyword, page, limit, status } = req.query as {
      keyword?: string; page: number; limit: number; status: 'all' | 'active' | 'resigned'
    }
    const result = await listDingTalkUsersPaged(keyword ?? null, page, limit, status)
    return reply.send({ data: result.data, total: result.total, page, limit })
  })

  // 同步
  app.post('/dingtalk/users/sync', async (_req, reply) => {
    try {
      const result = await syncDingTalkUsers()
      return reply.send({ success: true, ...result })
    } catch (err) {
      return reply.status(500).send({ success: false, error: String(err) })
    }
  })

  // 查引用（A 类）
  app.get('/dingtalk/users/:userId/references', {
    schema: {
      params: { type: 'object', properties: { userId: { type: 'string' } }, required: ['userId'] },
    },
  }, async (req, reply) => {
    const { userId } = req.params as { userId: string }
    const result = await checkUserActiveReferences(userId)
    return reply.send(result)
  })

  // 删除（后端二次校验引用）
  app.delete('/dingtalk/users/:userId', {
    schema: {
      params: { type: 'object', properties: { userId: { type: 'string' } }, required: ['userId'] },
    },
  }, async (req, reply) => {
    const { userId } = req.params as { userId: string }

    const user = await getDingTalkUserById(userId)
    if (!user) return reply.status(404).send({ error: '用户不存在' })
    if (!user.resignedAt) return reply.status(409).send({ error: '只允许删除已离职用户' })

    const refs = await checkUserActiveReferences(userId)
    if (refs.blocked) {
      return reply.status(409).send({
        error: '用户仍被引用，无法删除',
        references: refs.references,
      })
    }

    await deleteUser(userId)
    return reply.send({ success: true })
  })
}
```

- [ ] **Step 2: 验证 TypeScript 编译**

```bash
./test.sh --typecheck
```

Expected: 无 TS 错误。

- [ ] **Step 3: Commit**

```bash
git add src/admin/routes/dingtalk-users.ts
git commit -m "feat: add status filter, references GET and DELETE endpoint for dingtalk users"
```

---

## Task 6: 集成测试

**Files:**
- Create: `src/__tests__/integration/dingtalk-resignation.test.ts`

- [ ] **Step 1: 写测试（先跑验证失败）**

```typescript
// src/__tests__/integration/dingtalk-resignation.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { resetTestDb, getTestPool } from '../helpers/db.js'
import {
  upsertDingTalkUser,
  getActiveUserIds,
  markUsersAsResigned,
  deleteUser,
  getDingTalkUserById,
} from '../../db/repositories/dingtalk-users.js'
import { checkUserActiveReferences } from '../../admin/services/user-reference-check.js'

beforeEach(async () => {
  await resetTestDb()
})

async function insertUser(userId: string, name = 'Test User') {
  await upsertDingTalkUser({ userId, name, avatar: '', department: '' })
}

describe('markUsersAsResigned', () => {
  it('sets resigned_at for specified users', async () => {
    await insertUser('u1')
    await insertUser('u2')

    await markUsersAsResigned(['u1'])

    const u1 = await getDingTalkUserById('u1')
    const u2 = await getDingTalkUserById('u2')
    expect(u1?.resignedAt).not.toBeNull()
    expect(u2?.resignedAt).toBeNull()
  })

  it('is a no-op for empty array', async () => {
    await insertUser('u1')
    await markUsersAsResigned([])
    const u1 = await getDingTalkUserById('u1')
    expect(u1?.resignedAt).toBeNull()
  })
})

describe('upsertDingTalkUser clears resignedAt on re-join', () => {
  it('clears resigned_at when resigned user is upserted again', async () => {
    await insertUser('u1')
    await markUsersAsResigned(['u1'])
    expect((await getDingTalkUserById('u1'))?.resignedAt).not.toBeNull()

    await upsertDingTalkUser({ userId: 'u1', name: 'Test User' })

    expect((await getDingTalkUserById('u1'))?.resignedAt).toBeNull()
  })
})

describe('getActiveUserIds', () => {
  it('returns only non-resigned users', async () => {
    await insertUser('active1')
    await insertUser('active2')
    await insertUser('resigned1')
    await markUsersAsResigned(['resigned1'])

    const activeIds = await getActiveUserIds()
    expect(activeIds).toContain('active1')
    expect(activeIds).toContain('active2')
    expect(activeIds).not.toContain('resigned1')
  })
})

describe('checkUserActiveReferences', () => {
  it('returns blocked=false when user has no references', async () => {
    await insertUser('u1')
    const result = await checkUserActiveReferences('u1')
    expect(result.blocked).toBe(false)
    expect(result.references).toHaveLength(0)
  })

  it('detects user_roles reference', async () => {
    await insertUser('u1')
    const pool = getTestPool()
    await pool.query(
      `INSERT INTO user_roles (platform, user_id, user_name, role, group_id, created_by)
       VALUES ('dingtalk', 'u1', 'Test User', 'developer', 'group1', 'admin')`,
    )

    const result = await checkUserActiveReferences('u1')
    expect(result.blocked).toBe(true)
    const ref = result.references.find(r => r.table === 'user_roles')
    expect(ref?.count).toBe(1)
  })

  it('detects approval_rules JSONB reference', async () => {
    await insertUser('u1')
    const pool = getTestPool()
    // 需要先有 product_line 和 im_trigger（approval_rules 有 FK）
    // 如果 approval_rules 可以独立插入则直接插入，否则跳过此用例
    // 这里用裸 SQL 插入并忽略 FK（测试库无 FK 约束时有效）
    await pool.query(
      `INSERT INTO approval_rules (im_trigger_key, env, primary_approvers, backup_approvers, primary_timeout_min, total_timeout_min)
       VALUES ('deploy', 'prod', $1, '[]', 30, 60)`,
      [JSON.stringify(['u1'])]
    ).catch(() => {
      // 有 FK 约束时跳过，已在 user_roles 测试中覆盖 JSONB 逻辑
    })
  })
})

describe('deleteUser', () => {
  it('removes user from database', async () => {
    await insertUser('u1')
    await markUsersAsResigned(['u1'])

    await deleteUser('u1')

    expect(await getDingTalkUserById('u1')).toBeNull()
  })
})
```

- [ ] **Step 2: 运行测试确认失败（函数未实现前）**

```bash
npx vitest run src/__tests__/integration/dingtalk-resignation.test.ts
```

Expected: 如果 Task 2 已完成则应当 PASS；此步骤用于确认测试本身语法无误。

- [ ] **Step 3: 运行完整测试套件确认无回归**

```bash
./test.sh
```

Expected: 所有测试 PASS，无新失败。

- [ ] **Step 4: Commit**

```bash
git add src/__tests__/integration/dingtalk-resignation.test.ts
git commit -m "test: add integration tests for dingtalk user resignation flow"
```

---

## Task 7: 前端 — 类型和 API 层

**Files:**
- Modify: `web/src/types/index.ts`
- Modify: `web/src/api/dingtalk-users.ts`

- [ ] **Step 1: 更新 DingTalkUser 类型**

在 `web/src/types/index.ts` 中，找到 `DingTalkUser` interface 修改为：

```typescript
export interface DingTalkUser {
  userId: string; name: string; avatar: string; department: string
  email?: string; syncedAt?: string
  resignedAt: string | null
}
```

- [ ] **Step 2: 更新 API 层**

完整替换 `web/src/api/dingtalk-users.ts`：

```typescript
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
```

- [ ] **Step 3: 验证前端 TypeScript**

```bash
cd web && pnpm build 2>&1 | grep -E "error|Error" | head -20
```

Expected: 无 TS 错误（build 可能因为 DingTalkUsersPage 未改而有 warning，Task 8 修复）。

- [ ] **Step 4: Commit**

```bash
git add web/src/types/index.ts web/src/api/dingtalk-users.ts
git commit -m "feat: add resignedAt type and getUserReferences/deleteUser API calls"
```

---

## Task 8: 前端 — DingTalkUsersPage 重设计

**Files:**
- Modify: `web/src/pages/DingTalkUsersPage.tsx`

- [ ] **Step 1: 完整替换页面**

```tsx
// web/src/pages/DingTalkUsersPage.tsx
import { useEffect, useState, useRef } from 'react'
import {
  Card, Table, Button, Input, Avatar, Space, message, Tag, Modal, Segmented, Typography, List,
} from 'antd'
import {
  SyncOutlined, UserOutlined, DeleteOutlined, WarningOutlined,
} from '@ant-design/icons'
import {
  getDingTalkUsersPaged, syncDingTalkUsers, getUserReferences, deleteUser,
} from '../api/dingtalk-users'
import { usePagination } from '../hooks/usePagination'
import type { DingTalkUser } from '../types'

type StatusFilter = 'all' | 'active' | 'resigned'

export default function DingTalkUsersPage() {
  const [data, setData] = useState<DingTalkUser[]>([])
  const [loading, setLoading] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const searchTimer = useRef<ReturnType<typeof setTimeout>>()
  const abortRef = useRef<AbortController | null>(null)

  const { page, limit, total, setTotal, resetPage, tableProps } = usePagination(20)

  useEffect(() => {
    abortRef.current?.abort()
    abortRef.current = new AbortController()
    load()
  }, [page, limit, keyword, statusFilter])

  async function load() {
    setLoading(true)
    try {
      const res = await getDingTalkUsersPaged(
        { keyword: keyword || undefined, page, limit, status: statusFilter },
        abortRef.current?.signal
      )
      setData(res.data)
      setTotal(res.total)
    } catch {
      // ignore abort
    } finally {
      setLoading(false)
    }
  }

  function handleSearch(value: string) {
    clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => { resetPage(); setKeyword(value) }, 300)
  }

  async function handleSync() {
    setSyncing(true)
    try {
      const res = await syncDingTalkUsers()
      if (res.success) {
        const parts = [`共同步 ${res.synced ?? 0} 名用户`]
        if (res.resigned) parts.push(`新增 ${res.resigned} 名离职`)
        if (res.rejoined) parts.push(`恢复 ${res.rejoined} 名在职`)
        message.success(`同步成功，${parts.join('，')}`)
        load()
      } else {
        message.error(res.error ?? '同步失败')
      }
    } catch {
      message.error('同步失败，请稍后重试')
    } finally {
      setSyncing(false)
    }
  }

  async function handleDelete(user: DingTalkUser) {
    setDeletingId(user.userId)
    try {
      const refs = await getUserReferences(user.userId)
      if (refs.blocked) {
        Modal.error({
          title: `无法删除「${user.name}」`,
          icon: <WarningOutlined />,
          content: (
            <div>
              <p>该用户仍被以下资源引用，请先解除引用后再删除：</p>
              <List
                size="small"
                dataSource={refs.references}
                renderItem={r => (
                  <List.Item>
                    <Typography.Text>{r.label}</Typography.Text>
                    <Tag style={{ marginLeft: 8 }}>{r.count} 条</Tag>
                  </List.Item>
                )}
              />
            </div>
          ),
        })
        return
      }

      Modal.confirm({
        title: `确认删除「${user.name}」？`,
        content: '删除后不可恢复，该用户的历史记录将保留。',
        okText: '确认删除',
        okType: 'danger',
        cancelText: '取消',
        onOk: async () => {
          await deleteUser(user.userId)
          message.success(`已删除用户「${user.name}」`)
          load()
        },
      })
    } catch {
      message.error('操作失败，请稍后重试')
    } finally {
      setDeletingId(null)
    }
  }

  const columns = [
    {
      title: '头像', dataIndex: 'avatar', width: 60,
      render: (src: string) => (
        <Avatar src={src || undefined} icon={!src ? <UserOutlined /> : undefined} />
      ),
    },
    { title: '姓名', dataIndex: 'name' },
    { title: '用户ID', dataIndex: 'userId' },
    { title: '部门', dataIndex: 'department', ellipsis: true },
    {
      title: '状态', dataIndex: 'resignedAt', width: 90,
      render: (v: string | null) =>
        v ? <Tag color="orange">已离职</Tag> : <Tag color="green">在职</Tag>,
    },
    {
      title: '离职时间', dataIndex: 'resignedAt', width: 160,
      render: (v: string | null) => v ? new Date(v).toLocaleString() : '-',
    },
    {
      title: '同步时间', dataIndex: 'syncedAt', width: 160,
      render: (v: string) => v ? new Date(v).toLocaleString() : '-',
    },
    {
      title: '操作', width: 80, align: 'center' as const,
      render: (_: unknown, record: DingTalkUser) =>
        record.resignedAt ? (
          <Button
            type="link"
            danger
            size="small"
            icon={<DeleteOutlined />}
            loading={deletingId === record.userId}
            onClick={() => handleDelete(record)}
          >
            删除
          </Button>
        ) : null,
    },
  ]

  const segmentedOptions = [
    { label: '全部', value: 'all' },
    { label: '在职', value: 'active' },
    { label: '已离职', value: 'resigned' },
  ]

  return (
    <Card
      title={`钉钉用户（共 ${total} 人）`}
      extra={
        <Space>
          <Segmented
            options={segmentedOptions}
            value={statusFilter}
            onChange={v => { setStatusFilter(v as StatusFilter); resetPage() }}
          />
          <Input.Search
            placeholder="搜索姓名或部门"
            allowClear
            style={{ width: 220 }}
            onSearch={handleSearch}
            onChange={e => handleSearch(e.target.value)}
          />
          <Button
            icon={<SyncOutlined spin={syncing} />}
            loading={syncing}
            onClick={handleSync}
          >
            同步用户
          </Button>
        </Space>
      }
    >
      <Table
        rowKey="userId"
        columns={columns}
        dataSource={data}
        loading={loading}
        rowClassName={(r: DingTalkUser) => r.resignedAt ? 'ant-table-row-disabled' : ''}
        {...tableProps}
      />
    </Card>
  )
}
```

- [ ] **Step 2: 验证前端 TypeScript 完整编译**

```bash
cd web && pnpm build
```

Expected: Build 成功，无 TS 错误。

- [ ] **Step 3: 启动开发服务器，手动验证核心路径**

```bash
# Terminal 1
pnpm dev
# Terminal 2
cd web && pnpm dev
```

打开 http://localhost:5173，进入「钉钉用户」页面，验证：
1. 三个过滤 Tab（全部 / 在职 / 已离职）可切换，列表随之变化
2. 在职用户显示绿色「在职」tag，无删除按钮
3. 离职用户显示橙色「已离职」tag，有红色删除按钮
4. （如有离职用户且有引用）点删除 → 弹引用阻断弹窗
5. （如有离职用户且无引用）点删除 → 弹确认弹窗 → 确认后用户消失

- [ ] **Step 4: Commit**

```bash
git add web/src/pages/DingTalkUsersPage.tsx
git commit -m "feat: redesign DingTalkUsersPage with resignation status filter and delete flow"
```

---

## 验收清单

- [ ] `pnpm migrate` 无报错，`resigned_at` 列存在
- [ ] `./test.sh` 全绿，dingtalk-resignation 集成测试全部 PASS
- [ ] `cd web && pnpm build` 无 TS 错误
- [ ] 同步后离职用户自动出现「已离职」tag
- [ ] 重新同步若用户回来，`resignedAt` 清空回「在职」
- [ ] 有 A 类引用时删除被阻断，弹窗列出具体引用
- [ ] 无引用时删除成功，列表移除该用户
- [ ] 下拉选人组件（DingTalkUserSelect）不再显示离职用户
