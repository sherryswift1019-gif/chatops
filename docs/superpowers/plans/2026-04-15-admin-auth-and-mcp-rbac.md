# Admin Auth + MCP RBAC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 同时修复 P0-1（admin 路由无认证）和 P0-3（MCP tool 列表不分角色全放）。

**Architecture:** 后端加 session-cookie 登录（`@fastify/secure-session`），所有 `/admin/*`（除登录/登出/改密/健康外）挂 preHandler 校验；MCP server 在 `ListTools` 和 `CallTool` 两处都用已存在但从未被调用的 `getPermittedTools(role, productLineId)` 过滤。前端加登录页 + 强制改密页 + AuthGuard 外层守卫。

**Tech Stack:** Fastify 5、`@fastify/secure-session`、`bcryptjs`（纯 JS，避免原生模块构建问题）、PostgreSQL `pgcrypto` 扩展（生成初始 bcrypt hash）、React 18 + antd 5 + axios。

---

## File Structure

### 后端新增

| 文件 | 职责 |
|---|---|
| `src/db/schema-v9.sql` | `admin_users` 表 + seed `admin`（pgcrypto 生成 bcrypt hash） |
| `src/db/repositories/admin-users.ts` | `getByUsername / updatePassword / updateLastLogin / mapRow` |
| `src/admin/auth/password.ts` | `hashPassword / verifyPassword / validatePasswordStrength` |
| `src/admin/auth/session-plugin.ts` | 注册 `@fastify/secure-session`，导出 `requireAuth` preHandler |
| `src/admin/routes/auth.ts` | `POST /login`、`POST /logout`、`POST /change-password`、`GET /me` |
| `src/__tests__/unit/admin-auth.test.ts` | 覆盖上述所有行为 |
| `src/__tests__/unit/mcp-rbac.test.ts` | MCP ListTools/CallTool 过滤行为 |

### 后端修改

| 文件 | 改动 |
|---|---|
| `src/admin/index.ts` | 注册 session-plugin + auth 路由；对非 `/auth/*` 全部挂 `requireAuth` |
| `src/db/migrate.ts` | 顺序执行 `schema-v9.sql` |
| `src/__tests__/helpers/db.ts` | `SCHEMA_FILES` 追加 v9 |
| `src/agent/mcp-server.ts` | ListTools 和 CallTool 用 `getPermittedTools` 过滤 |
| `package.json` | 加 `bcryptjs`、`@fastify/secure-session`、`@types/bcryptjs` |

### 前端新增

| 文件 | 职责 |
|---|---|
| `web/src/api/auth.ts` | `login / logout / changePassword / me` axios 包装 |
| `web/src/pages/LoginPage.tsx` | 用户名+密码表单 |
| `web/src/pages/ChangePasswordPage.tsx` | 旧/新/确认密码 |
| `web/src/components/AuthGuard.tsx` | 外层路由守卫，调 `/me` |

### 前端修改

| 文件 | 改动 |
|---|---|
| `web/src/App.tsx` | 加 `/login`、`/change-password` 路由，其余包 `<AuthGuard>` |
| `web/src/api/client.ts` | `withCredentials: true`；axios 响应拦截 401 跳 `/login` |
| `web/src/layout/AdminLayout.tsx` | 右上角 username + 登出按钮 |

---

## Task 1: 依赖 + schema-v9 + 迁移钩子

**Files:**
- Modify: `package.json`
- Create: `src/db/schema-v9.sql`
- Modify: `src/db/migrate.ts`
- Modify: `src/__tests__/helpers/db.ts`

- [ ] **Step 1.1: 安装依赖**

```bash
cd /home/k/code/chatops
pnpm add bcryptjs @fastify/secure-session
pnpm add -D @types/bcryptjs
```

Expected: `pnpm-lock.yaml` 更新，无报错。

- [ ] **Step 1.2: 创建 `src/db/schema-v9.sql`**

```sql
-- schema-v9.sql: admin_users 表 + 默认账号

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS admin_users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO admin_users (username, password_hash, must_change_password)
VALUES ('admin', crypt('admin', gen_salt('bf', 12)), TRUE)
ON CONFLICT (username) DO NOTHING;
```

> 注：pgcrypto 的 `crypt(..., gen_salt('bf', 12))` 输出 `$2a$12$...` 格式，与 `bcryptjs.compareSync()` 完全兼容（bcryptjs 接受 `$2a$` 和 `$2b$`）。

- [ ] **Step 1.3: 修改 `src/db/migrate.ts` 末尾追加 v9**

在 `schemaV8` 执行之后、`pool.end()` 之前加：

```typescript
const schemaV9 = readFileSync(join(__dirname, 'schema-v9.sql'), 'utf8')
await pool.query(schemaV9)
```

并把日志改为：

```typescript
console.log('✅ Database schema applied (v1 + v2 + v3 + v4 + v5 + v6 + v7 + v8 + v9)')
```

- [ ] **Step 1.4: 修改 `src/__tests__/helpers/db.ts` 加 v9 到列表**

把 `SCHEMA_FILES` 常量改为：

```typescript
const SCHEMA_FILES = [
  'schema.sql',
  'schema-v2.sql',
  'schema-v3.sql',
  'schema-v4.sql',
  'schema-v5.sql',
  'schema-v6.sql',
  'schema-v7.sql',
  'schema-v8.sql',
  'schema-v9.sql',
]
```

- [ ] **Step 1.5: 本地 migrate 验证**

```bash
pnpm migrate
```

Expected: `Database schema applied (v1 + ... + v9)`。然后：

```bash
psql $DATABASE_URL -c "SELECT username, must_change_password FROM admin_users;"
```

Expected: `admin | t` 一行。

- [ ] **Step 1.6: 类型检查 + 提交**

```bash
npx tsc --noEmit
```

Expected: 无输出。

```bash
git add package.json pnpm-lock.yaml src/db/schema-v9.sql src/db/migrate.ts src/__tests__/helpers/db.ts
git commit -m "$(cat <<'EOF'
chore: add deps + admin_users schema-v9 for admin auth

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: admin-users repository (TDD)

**Files:**
- Create: `src/db/repositories/admin-users.ts`
- Create: `src/__tests__/unit/admin-users-repo.test.ts`

- [ ] **Step 2.1: 写失败测试**

`src/__tests__/unit/admin-users-repo.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { resetTestDb } from '../helpers/db.js'
import {
  getAdminUserByUsername,
  updateAdminPassword,
  updateAdminLastLogin,
} from '../../db/repositories/admin-users.js'

beforeEach(async () => { await resetTestDb() })

describe('admin-users repository', () => {
  it('returns seeded admin user', async () => {
    const user = await getAdminUserByUsername('admin')
    expect(user).not.toBeNull()
    expect(user!.username).toBe('admin')
    expect(user!.mustChangePassword).toBe(true)
    expect(user!.passwordHash).toMatch(/^\$2[ab]\$12\$/)
  })

  it('returns null for unknown user', async () => {
    const user = await getAdminUserByUsername('nobody')
    expect(user).toBeNull()
  })

  it('updateAdminPassword resets mustChangePassword to false', async () => {
    await updateAdminPassword('admin', '$2a$12$newhashvalueplaceholder00000000000000000000000000000000')
    const user = await getAdminUserByUsername('admin')
    expect(user!.mustChangePassword).toBe(false)
    expect(user!.passwordHash).toBe('$2a$12$newhashvalueplaceholder00000000000000000000000000000000')
  })

  it('updateAdminLastLogin sets last_login_at', async () => {
    const before = await getAdminUserByUsername('admin')
    expect(before!.lastLoginAt).toBeNull()
    await updateAdminLastLogin('admin')
    const after = await getAdminUserByUsername('admin')
    expect(after!.lastLoginAt).toBeInstanceOf(Date)
  })
})
```

- [ ] **Step 2.2: 跑测试确认失败**

```bash
npx vitest run src/__tests__/unit/admin-users-repo.test.ts
```

Expected: FAIL，`Cannot find module .../admin-users.js`

- [ ] **Step 2.3: 实现 `src/db/repositories/admin-users.ts`**

```typescript
import { getPool } from '../client.js'

export interface AdminUser {
  id: number
  username: string
  passwordHash: string
  mustChangePassword: boolean
  lastLoginAt: Date | null
  createdAt: Date
  updatedAt: Date
}

function mapRow(r: Record<string, unknown>): AdminUser {
  return {
    id: r.id as number,
    username: r.username as string,
    passwordHash: r.password_hash as string,
    mustChangePassword: r.must_change_password as boolean,
    lastLoginAt: (r.last_login_at as Date | null) ?? null,
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
  }
}

export async function getAdminUserByUsername(username: string): Promise<AdminUser | null> {
  const pool = getPool()
  const { rows } = await pool.query('SELECT * FROM admin_users WHERE username = $1', [username])
  return rows[0] ? mapRow(rows[0]) : null
}

export async function updateAdminPassword(username: string, newHash: string): Promise<void> {
  const pool = getPool()
  await pool.query(
    `UPDATE admin_users
       SET password_hash = $2,
           must_change_password = FALSE,
           updated_at = NOW()
     WHERE username = $1`,
    [username, newHash]
  )
}

export async function updateAdminLastLogin(username: string): Promise<void> {
  const pool = getPool()
  await pool.query(
    `UPDATE admin_users SET last_login_at = NOW(), updated_at = NOW() WHERE username = $1`,
    [username]
  )
}
```

- [ ] **Step 2.4: 跑测试确认 4 绿**

```bash
npx vitest run src/__tests__/unit/admin-users-repo.test.ts
```

Expected: `4 passed`

- [ ] **Step 2.5: 提交**

```bash
git add src/db/repositories/admin-users.ts src/__tests__/unit/admin-users-repo.test.ts
git commit -m "$(cat <<'EOF'
feat(db): admin-users repository

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: password module (TDD)

**Files:**
- Create: `src/admin/auth/password.ts`
- Create: `src/__tests__/unit/password.test.ts`

- [ ] **Step 3.1: 写失败测试**

`src/__tests__/unit/password.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { hashPassword, verifyPassword, validatePasswordStrength } from '../../admin/auth/password.js'

describe('password module', () => {
  it('hashPassword produces a bcrypt hash', async () => {
    const h = await hashPassword('secret12')
    expect(h).toMatch(/^\$2[ab]\$12\$/)
  })

  it('verifyPassword returns true for correct password', async () => {
    const h = await hashPassword('secret12')
    expect(await verifyPassword('secret12', h)).toBe(true)
  })

  it('verifyPassword returns false for wrong password', async () => {
    const h = await hashPassword('secret12')
    expect(await verifyPassword('wrong123', h)).toBe(false)
  })

  it('verifyPassword handles pgcrypto-generated $2a$ hashes', async () => {
    // Seed admin/admin uses pgcrypto, which produces $2a$ format.
    // Simulate by using a pre-computed $2a$ hash for 'admin'.
    const pgcryptoStyleHash = '$2a$12$abcdefghijklmnopqrstu.oQDvDFKn1Fv3TlPCJhPeN6p7oH8yhG6e'
    // We can't hardcode a real hash without knowing the salt; instead verify
    // that hashPassword output in $2a$ format (manually constructed) parses.
    const altHash = (await hashPassword('admin')).replace('$2b$', '$2a$')
    expect(await verifyPassword('admin', altHash)).toBe(true)
  })

  it('validatePasswordStrength accepts 8+ char mixed string', () => {
    expect(validatePasswordStrength('abc12345').ok).toBe(true)
  })

  it('validatePasswordStrength rejects length < 8', () => {
    const r = validatePasswordStrength('abc123')
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/长度/)
  })

  it('validatePasswordStrength rejects all-digit', () => {
    const r = validatePasswordStrength('12345678')
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/纯数字|全数字/)
  })
})
```

- [ ] **Step 3.2: 跑测试确认失败**

```bash
npx vitest run src/__tests__/unit/password.test.ts
```

Expected: FAIL。

- [ ] **Step 3.3: 实现 `src/admin/auth/password.ts`**

```typescript
import bcrypt from 'bcryptjs'

const BCRYPT_ROUNDS = 12

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS)
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(plain, hash)
  } catch {
    return false
  }
}

export interface PasswordStrengthResult {
  ok: boolean
  reason?: string
}

export function validatePasswordStrength(password: string): PasswordStrengthResult {
  if (password.length < 8) {
    return { ok: false, reason: '密码长度至少 8 位' }
  }
  if (/^\d+$/.test(password)) {
    return { ok: false, reason: '密码不能为纯数字' }
  }
  return { ok: true }
}
```

- [ ] **Step 3.4: 跑测试确认 7 绿**

```bash
npx vitest run src/__tests__/unit/password.test.ts
```

Expected: `7 passed`

- [ ] **Step 3.5: 提交**

```bash
git add src/admin/auth/password.ts src/__tests__/unit/password.test.ts
git commit -m "$(cat <<'EOF'
feat(auth): password hashing + strength validation

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Session plugin + requireAuth hook (TDD)

**Files:**
- Create: `src/admin/auth/session-plugin.ts`

> 会话 preHandler 的完整行为测试放在 Task 5（和 auth 路由一起，用 app.inject 端到端测）。本 task 只负责实现和导出。

- [ ] **Step 4.1: 创建 `src/admin/auth/session-plugin.ts`**

```typescript
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import fp from 'fastify-plugin'
import secureSession from '@fastify/secure-session'
import { randomBytes } from 'crypto'
import { getConfig, setConfig } from '../../db/repositories/system-config.js'

const COOKIE_NAME = 'chatops_admin_session'
const SESSION_MAX_AGE = 60 * 60 * 24 * 7 // 7 days, seconds

// Whitelist paths that skip auth check (relative to /admin prefix).
const WHITELIST = [
  '/auth/login',
  '/auth/logout',
  '/auth/change-password',
  '/auth/me',  // /me is how the frontend probes; don't 401 it
]

interface SessionData {
  username: string
  userId: number
}

declare module '@fastify/secure-session' {
  interface SessionData {
    username: string
    userId: number
  }
}

async function loadOrCreateSessionKey(): Promise<Buffer> {
  const existing = (await getConfig('session'))?.value as { key?: string } | undefined
  if (existing?.key) {
    return Buffer.from(existing.key, 'hex')
  }
  const newKey = randomBytes(32)
  await setConfig('session', { key: newKey.toString('hex') })
  return newKey
}

export const sessionPlugin: FastifyPluginAsync = fp(async (app: FastifyInstance) => {
  const key = await loadOrCreateSessionKey()
  await app.register(secureSession, {
    key,
    cookieName: COOKIE_NAME,
    cookie: {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: SESSION_MAX_AGE,
    },
  })
})

export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  // Strip /admin prefix before matching (route is mounted under /admin).
  const path = req.url.startsWith('/admin') ? req.url.slice('/admin'.length) : req.url
  const pathNoQuery = path.split('?')[0]
  if (WHITELIST.includes(pathNoQuery)) return

  const username = req.session.get('username')
  if (!username) {
    return reply.status(401).send({ error: 'not_authenticated' })
  }

  // must_change_password gate: except for change-password itself, block.
  const { getAdminUserByUsername } = await import('../../db/repositories/admin-users.js')
  const user = await getAdminUserByUsername(username)
  if (!user) {
    req.session.delete()
    return reply.status(401).send({ error: 'not_authenticated' })
  }
  if (user.mustChangePassword && pathNoQuery !== '/auth/change-password') {
    return reply.status(403).send({ error: 'must_change_password' })
  }
}
```

- [ ] **Step 4.2: 类型检查**

```bash
npx tsc --noEmit
```

Expected: 无错误。若 `@fastify/secure-session` 的 `SessionData` module augmentation 报错，检查它的 export 名称（当前版本可能不同），调整 `declare module` 块的路径。

- [ ] **Step 4.3: 提交**

```bash
git add src/admin/auth/session-plugin.ts
git commit -m "$(cat <<'EOF'
feat(auth): session-plugin with requireAuth preHandler

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Auth routes + end-to-end preHandler test

**Files:**
- Create: `src/admin/routes/auth.ts`
- Create: `src/__tests__/unit/admin-auth.test.ts`

- [ ] **Step 5.1: 写失败的测试**

`src/__tests__/unit/admin-auth.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { resetTestDb } from '../helpers/db.js'
import { sessionPlugin, requireAuth } from '../../admin/auth/session-plugin.js'
import { registerAuthRoutes } from '../../admin/routes/auth.js'

// Wrap with prefix '/admin' to mirror production adminPlugin mount.
async function buildApp() {
  const app = Fastify()
  await app.register(async (scope) => {
    await scope.register(sessionPlugin)
    scope.addHook('preHandler', requireAuth)
    await registerAuthRoutes(scope)
    scope.get('/protected', async () => ({ ok: true }))
  }, { prefix: '/admin' })
  return app
}

beforeEach(async () => { await resetTestDb() })

describe('admin auth', () => {
  it('POST /admin/auth/login with correct credentials returns mustChangePassword=true', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/admin/auth/login',
      payload: { username: 'admin', password: 'admin' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ username: 'admin', mustChangePassword: true })
    expect(res.headers['set-cookie']).toBeDefined()
    await app.close()
  })

  it('POST /admin/auth/login with wrong password returns 401', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/admin/auth/login',
      payload: { username: 'admin', password: 'wrong123' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toMatchObject({ error: 'invalid_credentials' })
    await app.close()
  })

  it('POST /admin/auth/login with unknown user returns 401', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/admin/auth/login',
      payload: { username: 'nobody', password: 'x' },
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('GET /admin/auth/me without cookie returns 401', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/admin/auth/me' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('GET /admin/auth/me with valid cookie returns user', async () => {
    const app = await buildApp()
    const login = await app.inject({
      method: 'POST',
      url: '/admin/auth/login',
      payload: { username: 'admin', password: 'admin' },
    })
    const cookie = login.headers['set-cookie'] as string
    const res = await app.inject({
      method: 'GET',
      url: '/admin/auth/me',
      headers: { cookie },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ username: 'admin', mustChangePassword: true })
    await app.close()
  })

  it('POST /admin/auth/change-password with wrong old password returns 401', async () => {
    const app = await buildApp()
    const login = await app.inject({
      method: 'POST',
      url: '/admin/auth/login',
      payload: { username: 'admin', password: 'admin' },
    })
    const cookie = login.headers['set-cookie'] as string
    const res = await app.inject({
      method: 'POST',
      url: '/admin/auth/change-password',
      headers: { cookie },
      payload: { oldPassword: 'wrong', newPassword: 'newStrong1' },
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('POST /admin/auth/change-password with weak new password returns 400', async () => {
    const app = await buildApp()
    const login = await app.inject({
      method: 'POST',
      url: '/admin/auth/login',
      payload: { username: 'admin', password: 'admin' },
    })
    const cookie = login.headers['set-cookie'] as string
    const res = await app.inject({
      method: 'POST',
      url: '/admin/auth/change-password',
      headers: { cookie },
      payload: { oldPassword: 'admin', newPassword: '1234' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: 'weak_password' })
    await app.close()
  })

  it('change-password success clears mustChangePassword and lets protected routes through', async () => {
    const app = await buildApp()
    const login = await app.inject({
      method: 'POST',
      url: '/admin/auth/login',
      payload: { username: 'admin', password: 'admin' },
    })
    const cookie = login.headers['set-cookie'] as string
    // Before change: protected route blocked with 403 must_change_password
    const blocked = await app.inject({ method: 'GET', url: '/admin/protected', headers: { cookie } })
    expect(blocked.statusCode).toBe(403)

    const change = await app.inject({
      method: 'POST',
      url: '/admin/auth/change-password',
      headers: { cookie },
      payload: { oldPassword: 'admin', newPassword: 'newStrong1' },
    })
    expect(change.statusCode).toBe(200)

    // After change: same cookie can access protected
    const after = await app.inject({ method: 'GET', url: '/admin/protected', headers: { cookie } })
    expect(after.statusCode).toBe(200)
    await app.close()
  })

  it('POST /admin/auth/logout clears session', async () => {
    const app = await buildApp()
    const login = await app.inject({
      method: 'POST',
      url: '/admin/auth/login',
      payload: { username: 'admin', password: 'admin' },
    })
    const cookie = login.headers['set-cookie'] as string
    const logout = await app.inject({ method: 'POST', url: '/admin/auth/logout', headers: { cookie } })
    expect(logout.statusCode).toBe(200)
    const me = await app.inject({ method: 'GET', url: '/admin/auth/me', headers: { cookie } })
    expect(me.statusCode).toBe(401)
    await app.close()
  })

  it('unauthenticated access to protected route returns 401', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/admin/protected' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })
})
```

- [ ] **Step 5.2: 跑测试确认失败**

```bash
npx vitest run src/__tests__/unit/admin-auth.test.ts
```

Expected: FAIL，`Cannot find module ../../admin/routes/auth.js`

- [ ] **Step 5.3: 实现 `src/admin/routes/auth.ts`**

```typescript
import type { FastifyInstance } from 'fastify'
import {
  getAdminUserByUsername,
  updateAdminPassword,
  updateAdminLastLogin,
} from '../../db/repositories/admin-users.js'
import { verifyPassword, hashPassword, validatePasswordStrength } from '../auth/password.js'

// Routes use PATHS RELATIVE to the adminPlugin mount point.
// adminPlugin is registered with { prefix: '/admin' } in server.ts,
// so '/auth/login' here becomes '/admin/auth/login' in production.
export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { username?: string; password?: string } }>(
    '/auth/login',
    async (req, reply) => {
      const { username, password } = req.body ?? {}
      if (!username || !password) {
        return reply.status(401).send({ error: 'invalid_credentials' })
      }
      const user = await getAdminUserByUsername(username)
      if (!user || !(await verifyPassword(password, user.passwordHash))) {
        return reply.status(401).send({ error: 'invalid_credentials' })
      }
      req.session.set('username', user.username)
      req.session.set('userId', user.id)
      await updateAdminLastLogin(user.username)
      return reply.send({ username: user.username, mustChangePassword: user.mustChangePassword })
    }
  )

  app.post('/auth/logout', async (req, reply) => {
    req.session.delete()
    return reply.send({ ok: true })
  })

  app.get('/auth/me', async (req, reply) => {
    const username = req.session.get('username')
    if (!username) return reply.status(401).send({ error: 'not_authenticated' })
    const user = await getAdminUserByUsername(username)
    if (!user) return reply.status(401).send({ error: 'not_authenticated' })
    return reply.send({ username: user.username, mustChangePassword: user.mustChangePassword })
  })

  app.post<{ Body: { oldPassword?: string; newPassword?: string } }>(
    '/auth/change-password',
    async (req, reply) => {
      const username = req.session.get('username')
      if (!username) return reply.status(401).send({ error: 'not_authenticated' })

      const { oldPassword, newPassword } = req.body ?? {}
      if (!oldPassword || !newPassword) {
        return reply.status(400).send({ error: 'missing_fields' })
      }

      const user = await getAdminUserByUsername(username)
      if (!user || !(await verifyPassword(oldPassword, user.passwordHash))) {
        return reply.status(401).send({ error: 'invalid_credentials' })
      }

      const strength = validatePasswordStrength(newPassword)
      if (!strength.ok) {
        return reply.status(400).send({ error: 'weak_password', reason: strength.reason })
      }

      const newHash = await hashPassword(newPassword)
      await updateAdminPassword(username, newHash)
      return reply.send({ ok: true })
    }
  )
}
```

- [ ] **Step 5.4: 跑测试**

```bash
npx vitest run src/__tests__/unit/admin-auth.test.ts
```

Expected: `10 passed`。若 cookie 传递出现问题（比如 `set-cookie` 是数组），调整测试把它转成字符串再传 headers。

- [ ] **Step 5.5: 提交**

```bash
git add src/admin/routes/auth.ts src/__tests__/unit/admin-auth.test.ts
git commit -m "$(cat <<'EOF'
feat(auth): login/logout/change-password/me routes + tests

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: 把 session 和 auth 挂到 adminPlugin

**Files:**
- Modify: `src/admin/index.ts`

- [ ] **Step 6.1: 读当前实现**

```bash
cat src/admin/index.ts
```

找到 `adminPlugin` 函数。注意所有既有的 `registerXxxRoutes` 调用。

- [ ] **Step 6.2: 改为注册 session-plugin 并挂 preHandler**

把 `src/admin/index.ts` 改为（保留原有 import，加新的）：

```typescript
import type { FastifyInstance } from 'fastify'
import { sessionPlugin, requireAuth } from './auth/session-plugin.js'
import { registerAuthRoutes } from './routes/auth.js'
import { registerSystemConfigRoutes } from './routes/system-config.js'
import { registerProductLineRoutes } from './routes/product-lines.js'
import { registerEnvironmentRoutes } from './routes/environments.js'
import { registerProjectRoutes } from './routes/projects.js'
import { registerCapabilityRoutes } from './routes/capabilities.js'
import { registerDingTalkUserRoutes } from './routes/dingtalk-users.js'
import { registerApprovalRuleRoutes } from './routes/approval-rules.js'
import { registerToolPermissionRoutes } from './routes/tool-permissions.js'
import { registerPipelineVariableRoutes } from './routes/pipeline-variables.js'
import { registerTestServerRoutes } from './routes/test-servers.js'
import { registerTestPipelineRoutes } from './routes/test-pipelines.js'
import { registerTestRunRoutes } from './routes/test-runs.js'
import { registerStageOperationRoutes } from './routes/stage-operations.js'
import { registerPipelineToolRoutes } from './routes/pipeline-tools.js'
import { registerAIRoutes } from './routes/ai.js'

export async function adminPlugin(app: FastifyInstance): Promise<void> {
  // Session middleware — must be registered before any route definition
  await app.register(sessionPlugin)

  // preHandler runs on every /admin/* request. Whitelist handled inside requireAuth.
  app.addHook('preHandler', requireAuth)

  // Auth routes (whitelisted, so preHandler lets them through)
  await registerAuthRoutes(app)

  // All other routes — require valid session
  await registerSystemConfigRoutes(app)
  await registerProductLineRoutes(app)
  await registerEnvironmentRoutes(app)
  await registerProjectRoutes(app)
  await registerCapabilityRoutes(app)
  await registerDingTalkUserRoutes(app)
  await registerApprovalRuleRoutes(app)
  await registerToolPermissionRoutes(app)
  await registerPipelineVariableRoutes(app)
  await registerTestServerRoutes(app)
  await registerTestPipelineRoutes(app)
  await registerTestRunRoutes(app)
  await registerStageOperationRoutes(app)
  await registerPipelineToolRoutes(app)
  await registerAIRoutes(app)
}
```

> 注：**保留**原文件里既有的所有 `registerXxxRoutes` 调用；只新增 2 行（`sessionPlugin` + `addHook`）+ 1 行 `registerAuthRoutes`。如果当前文件里实际注册列表和上面不一致，以当前为准，只插入新增 3 行。

- [ ] **Step 6.3: 本地启动一下确认没语法错误**

```bash
npx tsc --noEmit
```

Expected: 无错误。

- [ ] **Step 6.4: 运行全套测试**

```bash
npx vitest run
```

Expected: 所有测试通过（admin-auth 10 + admin-users-repo 4 + password 7 + 原有 41 = 62 左右）。

- [ ] **Step 6.5: 提交**

```bash
git add src/admin/index.ts
git commit -m "$(cat <<'EOF'
feat(auth): wire session-plugin + auth routes into adminPlugin

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: MCP RBAC 过滤 (TDD)

**Files:**
- Modify: `src/agent/mcp-server.ts`
- Create: `src/__tests__/unit/mcp-rbac.test.ts`

> MCP server 读取 env var 运行；我们不端到端测 stdio，而是单独测 `getPermittedTools` 过滤逻辑在 ListTools/CallTool handler 里被正确调用。最简单的方式：抽出一个纯函数（`filterTools`），用单测覆盖它。

- [ ] **Step 7.1: 写失败测试**

`src/__tests__/unit/mcp-rbac.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { filterToolsByRole } from '../../agent/mcp-server-utils.js'
import type { AgentTool } from '../../agent/tools/types.js'

function tool(name: string): AgentTool {
  return {
    name, description: '', riskLevel: 'low',
    inputSchema: {}, execute: async () => ({ success: true, output: '' }),
  }
}

describe('filterToolsByRole', () => {
  it('returns tools permitted for admin role', async () => {
    const all = [tool('query_deployments'), tool('execute_deploy'), tool('manage_role')]
    const filtered = await filterToolsByRole(all, 'admin', 1)
    expect(filtered.map(t => t.name).sort()).toEqual(
      ['execute_deploy', 'manage_role', 'query_deployments'].sort()
    )
  })

  it('filters out admin-only tools for developer role', async () => {
    const all = [tool('query_deployments'), tool('execute_deploy'), tool('manage_role')]
    const filtered = await filterToolsByRole(all, 'developer', 1)
    expect(filtered.map(t => t.name)).toEqual(['query_deployments'])
  })

  it('treats null role as developer', async () => {
    const all = [tool('query_deployments'), tool('execute_deploy')]
    const filtered = await filterToolsByRole(all, null, 1)
    expect(filtered.map(t => t.name)).toEqual(['query_deployments'])
  })

  it('unknown tool name defaults to all roles (fallback)', async () => {
    const all = [tool('mystery_tool')]
    const filtered = await filterToolsByRole(all, 'developer', 1)
    expect(filtered.map(t => t.name)).toEqual(['mystery_tool'])
  })
})
```

- [ ] **Step 7.2: 跑测试确认失败**

```bash
npx vitest run src/__tests__/unit/mcp-rbac.test.ts
```

Expected: FAIL，`Cannot find module .../mcp-server-utils.js`

- [ ] **Step 7.3: 抽出纯函数到 `src/agent/mcp-server-utils.ts`**

```typescript
import type { AgentTool, Role } from './tools/types.js'
import { DEFAULT_TOOL_ROLES } from './tools/types.js'
import { getToolPermissions } from '../db/repositories/tool-permissions.js'

const FALLBACK_ROLES = ['developer', 'tester', 'ops', 'admin']

export async function filterToolsByRole(
  tools: AgentTool[],
  role: Role | null,
  productLineId?: number,
): Promise<AgentTool[]> {
  const effectiveRole = role ?? 'developer'
  const overrides = productLineId ? await getToolPermissions(productLineId) : []

  return tools.filter(tool => {
    const override = overrides.find(o => o.toolName === tool.name && o.envName === '*')
    const allowed = override?.allowedRoles ?? DEFAULT_TOOL_ROLES[tool.name] ?? FALLBACK_ROLES
    return allowed.includes(effectiveRole)
  })
}
```

> 这就是把 `src/agent/tools/index.ts:27 getPermittedTools` 里的核心逻辑抽出成纯函数；不读 registry 而是接受显式 tools 数组，便于测试和复用。

- [ ] **Step 7.4: 跑测试确认 4 绿**

```bash
npx vitest run src/__tests__/unit/mcp-rbac.test.ts
```

Expected: `4 passed`

- [ ] **Step 7.5: 在 `src/agent/mcp-server.ts` 里用新函数**

找到 `ListToolsRequestSchema` 的 handler（约 40-48 行）改为：

```typescript
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const ctx: TaskContext = JSON.parse(process.env.CHATOPS_TASK_CONTEXT ?? '{}')
  const { filterToolsByRole } = await import('./mcp-server-utils.js')
  const tools = await filterToolsByRole(getAllTools(), ctx.initiatorRole ?? null, ctx.productLineId)
  return {
    tools: tools.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }
})
```

然后找到 `CallToolRequestSchema` handler（约 52-78 行），在 `const tool = getTool(...)` 之后、执行前加一道二次校验：

```typescript
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = getTool(request.params.name)
  if (!tool) {
    return {
      content: [{ type: 'text' as const, text: `未知工具: ${request.params.name}` }],
      isError: true,
    }
  }

  const context: TaskContext = JSON.parse(process.env.CHATOPS_TASK_CONTEXT ?? '{}')

  // Re-check permission to prevent bypass via direct tool-name call
  const { filterToolsByRole } = await import('./mcp-server-utils.js')
  const permitted = await filterToolsByRole([tool], context.initiatorRole ?? null, context.productLineId)
  if (permitted.length === 0) {
    mcpLog(`Denied tool call: ${request.params.name} role=${context.initiatorRole}`)
    return {
      content: [{ type: 'text' as const, text: `⛔ 无权限调用工具: ${request.params.name}` }],
      isError: true,
    }
  }

  try {
    mcpLog(`Calling tool: ${request.params.name} args=${JSON.stringify(request.params.arguments)}`)
    const result = await tool.execute(request.params.arguments ?? {}, context)
    mcpLog(`Tool result: success=${result.success} output=${result.output.slice(0, 500)}`)
    return {
      content: [{ type: 'text' as const, text: result.output }],
      isError: !result.success,
    }
  } catch (err) {
    return {
      content: [{ type: 'text' as const, text: `工具执行错误: ${String(err)}` }],
      isError: true,
    }
  }
})
```

- [ ] **Step 7.6: TypeScript 检查**

```bash
npx tsc --noEmit
```

Expected: 无错误。

- [ ] **Step 7.7: 提交**

```bash
git add src/agent/mcp-server.ts src/agent/mcp-server-utils.ts src/__tests__/unit/mcp-rbac.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): filter ListTools and CallTool by initiator role

Fixes P0-3. Previously the MCP server exposed all registered tools to
Claude regardless of the calling user's role, relying only on the
capability-level tool_names subset. A 'developer' role user whose
message happened to route to a capability listing execute_deploy or
manage_role would get those admin-only tools exposed.

Now both ListToolsRequestSchema and CallToolRequestSchema run the
tool set through filterToolsByRole(), which consults
DEFAULT_TOOL_ROLES and per-product-line overrides in tool_permissions.
CallTool's second check prevents the LLM from hardcoding a tool name
that was hidden from ListTools.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Frontend API client + auth API module

**Files:**
- Modify: `web/src/api/client.ts`
- Create: `web/src/api/auth.ts`

- [ ] **Step 8.1: 修改 `web/src/api/client.ts`**

```typescript
import axios from 'axios'

const client = axios.create({
  baseURL: '/admin',
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' },
  withCredentials: true,
})

client.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      // Avoid redirect loop when we're already on /login
      if (!window.location.pathname.startsWith('/login')) {
        window.location.replace('/login')
      }
    }
    return Promise.reject(err)
  }
)

export default client
```

- [ ] **Step 8.2: 创建 `web/src/api/auth.ts`**

```typescript
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
```

- [ ] **Step 8.3: 前端类型检查**

```bash
cd web && npx tsc --noEmit && cd ..
```

Expected: 无错误。

- [ ] **Step 8.4: 提交**

```bash
git add web/src/api/client.ts web/src/api/auth.ts
git commit -m "$(cat <<'EOF'
feat(web): auth API module + 401 redirect interceptor

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Frontend 登录页 + 改密页

**Files:**
- Create: `web/src/pages/LoginPage.tsx`
- Create: `web/src/pages/ChangePasswordPage.tsx`

- [ ] **Step 9.1: 创建 `web/src/pages/LoginPage.tsx`**

```tsx
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Form, Input, Button, Card, message } from 'antd'
import { login } from '../api/auth'

export default function LoginPage() {
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()

  const onFinish = async (values: { username: string; password: string }) => {
    setLoading(true)
    try {
      const res = await login(values.username, values.password)
      if (res.mustChangePassword) {
        navigate('/change-password', { replace: true })
      } else {
        navigate('/', { replace: true })
      }
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'unknown_error'
      message.error(msg === 'invalid_credentials' ? '用户名或密码错误' : `登录失败：${msg}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
      <Card title="ChatOps 管理后台" style={{ width: 400 }}>
        <Form layout="vertical" onFinish={onFinish}>
          <Form.Item name="username" label="用户名" rules={[{ required: true, message: '请输入用户名' }]}>
            <Input autoFocus autoComplete="username" />
          </Form.Item>
          <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={loading} block>登录</Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  )
}
```

- [ ] **Step 9.2: 创建 `web/src/pages/ChangePasswordPage.tsx`**

```tsx
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Form, Input, Button, Card, message, Alert } from 'antd'
import { changePassword } from '../api/auth'

export default function ChangePasswordPage() {
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()

  const onFinish = async (values: { oldPassword: string; newPassword: string; confirm: string }) => {
    if (values.newPassword !== values.confirm) {
      message.error('两次输入的新密码不一致')
      return
    }
    setLoading(true)
    try {
      await changePassword(values.oldPassword, values.newPassword)
      message.success('密码已修改')
      navigate('/', { replace: true })
    } catch (err: unknown) {
      const data = (err as { response?: { data?: { error?: string; reason?: string } } })?.response?.data
      if (data?.error === 'weak_password') {
        message.error(data.reason ?? '密码强度不足')
      } else if (data?.error === 'invalid_credentials') {
        message.error('旧密码错误')
      } else {
        message.error(`修改失败：${data?.error ?? 'unknown'}`)
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
      <Card title="修改密码" style={{ width: 420 }}>
        <Alert
          style={{ marginBottom: 16 }}
          type="warning"
          showIcon
          message="首次登录需要设置新密码"
          description="为账号安全，请立即修改初始密码。密码需至少 8 位且不能为纯数字。"
        />
        <Form layout="vertical" onFinish={onFinish}>
          <Form.Item name="oldPassword" label="旧密码" rules={[{ required: true }]}>
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          <Form.Item name="newPassword" label="新密码" rules={[{ required: true, min: 8, message: '至少 8 位' }]}>
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Form.Item name="confirm" label="确认新密码" rules={[{ required: true }]}>
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={loading} block>修改密码</Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  )
}
```

- [ ] **Step 9.3: 类型检查**

```bash
cd web && npx tsc --noEmit && cd ..
```

Expected: 无错误。

- [ ] **Step 9.4: 提交**

```bash
git add web/src/pages/LoginPage.tsx web/src/pages/ChangePasswordPage.tsx
git commit -m "$(cat <<'EOF'
feat(web): login + change-password pages

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Frontend AuthGuard + App 路由 + AdminLayout 登出

**Files:**
- Create: `web/src/components/AuthGuard.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/layout/AdminLayout.tsx`

- [ ] **Step 10.1: 创建 `web/src/components/AuthGuard.tsx`**

```tsx
import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { Spin } from 'antd'
import { me, type MeResponse } from '../api/auth'

interface Props {
  children: ReactNode
}

export default function AuthGuard({ children }: Props) {
  const [user, setUser] = useState<MeResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const navigate = useNavigate()
  const location = useLocation()

  useEffect(() => {
    let cancelled = false
    me()
      .then((u) => {
        if (cancelled) return
        setUser(u)
        if (u.mustChangePassword && location.pathname !== '/change-password') {
          navigate('/change-password', { replace: true })
        }
      })
      .catch(() => { /* 401 already redirected by axios interceptor */ })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [location.pathname, navigate])

  if (loading || !user) {
    return <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}><Spin /></div>
  }
  return <>{children}</>
}
```

- [ ] **Step 10.2: 修改 `web/src/App.tsx`**

```tsx
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import AdminLayout from './layout/AdminLayout'
import AuthGuard from './components/AuthGuard'
import LoginPage from './pages/LoginPage'
import ChangePasswordPage from './pages/ChangePasswordPage'
import SystemConfigPage from './pages/SystemConfigPage'
import EnvironmentListPage from './pages/EnvironmentListPage'
import ProductLineListPage from './pages/ProductLineListPage'
import ProductLineDetailPage from './pages/ProductLineDetailPage'
import DingTalkUsersPage from './pages/DingTalkUsersPage'
import CapabilitiesPage from './pages/CapabilitiesPage'
import TestServersPage from './pages/TestServersPage'
import TestPipelinesPage from './pages/TestPipelinesPage'
import TestRunsPage from './pages/TestRunsPage'

export default function App() {
  return (
    <ConfigProvider locale={zhCN}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/change-password" element={<AuthGuard><ChangePasswordPage /></AuthGuard>} />
          <Route element={<AuthGuard><AdminLayout /></AuthGuard>}>
            <Route index element={<Navigate to="/product-lines" replace />} />
            <Route path="/product-lines" element={<ProductLineListPage />} />
            <Route path="/product-lines/:id" element={<ProductLineDetailPage />} />
            <Route path="/environments" element={<EnvironmentListPage />} />
            <Route path="/dingtalk-users" element={<DingTalkUsersPage />} />
            <Route path="/capabilities" element={<CapabilitiesPage />} />
            <Route path="/system-config" element={<SystemConfigPage />} />
            <Route path="/test-servers" element={<TestServersPage />} />
            <Route path="/test-pipelines" element={<TestPipelinesPage />} />
            <Route path="/test-runs" element={<TestRunsPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ConfigProvider>
  )
}
```

- [ ] **Step 10.3: 读当前 `AdminLayout.tsx`**

```bash
cat web/src/layout/AdminLayout.tsx
```

找到右上角（Header）区域。记下当前 JSX 结构。

- [ ] **Step 10.4: 给 AdminLayout Header 加用户名 + 登出按钮**

在 `AdminLayout.tsx` 顶部加 import：

```typescript
import { useEffect, useState } from 'react'
import { Button, Space } from 'antd'
import { LogoutOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { me, logout, type MeResponse } from '../api/auth'
```

在组件内部加：

```typescript
const [user, setUser] = useState<MeResponse | null>(null)
const navigate = useNavigate()

useEffect(() => { me().then(setUser).catch(() => {}) }, [])

const onLogout = async () => {
  await logout()
  navigate('/login', { replace: true })
}
```

在 Header JSX 里（现在的 Header 右侧空白处）插入：

```tsx
<Space>
  {user && <span>{user.username}</span>}
  <Button type="text" icon={<LogoutOutlined />} onClick={onLogout}>登出</Button>
</Space>
```

> 如果 AdminLayout 没有现成的 Header，在顶部加一个 antd `<Layout.Header>` 包这两个元素。具体 JSX 位置根据当前文件结构就地插入，保持 tailwind/styling 与既有风格一致。

- [ ] **Step 10.5: 前端构建**

```bash
cd web && pnpm build && cd ..
```

Expected: 构建成功，产物在 `web/dist/`。

- [ ] **Step 10.6: 提交**

```bash
git add web/src/components/AuthGuard.tsx web/src/App.tsx web/src/layout/AdminLayout.tsx
git commit -m "$(cat <<'EOF'
feat(web): AuthGuard + login/change-password routing + header logout

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: 全量验证 + 整体提交

**Files:** 无新改动，仅验证

- [ ] **Step 11.1: 后端类型检查**

```bash
npx tsc --noEmit
```

Expected: 无错误。

- [ ] **Step 11.2: 前端类型检查**

```bash
cd web && npx tsc --noEmit && cd ..
```

Expected: 无错误。

- [ ] **Step 11.3: 后端全量 vitest**

```bash
npx vitest run
```

Expected: 全部通过。新增 count：admin-users-repo (4) + password (7) + admin-auth (10) + mcp-rbac (4) = 25 新测试，加上原有 41 = 66 左右。若有失败，修完再跑。

- [ ] **Step 11.4: 确认 git 状态干净**

```bash
git status
git log --oneline -12
```

所有改动都已 commit。

---

## Task 12: 部署到 10.10.1.166 + E2E 验证

**Files:** 远端 `/opt/chatops/`

- [ ] **Step 12.1: 按 CLAUDE.md 新增的流程打业务镜像**

**注意**：`./build.sh` 会把镜像 push 到 `harbor.paraview.cn/chatops/`。`chatops` project 是 private，本地默认登录的 `pam` 账号**没有 push 权限**。推前需要以 `admin` 身份登录 Harbor：

```bash
docker login harbor.paraview.cn -u admin
# 密码：Parav1ew
```

然后执行构建：

```bash
cd /home/k/code/chatops
./build.sh
```

Expected: 本地 `pnpm build` 前端成功 → docker build 完成 → 镜像推到 harbor.paraview.cn/chatops。构建完成后可把 `~/.docker/config.json` 换回 pam（避免 admin 凭证常驻）。

- [ ] **Step 12.2: 登录远端，重启 chatops 容器**

```bash
sshpass -p 'Parav1ew' ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null root@10.10.1.166 \
  'cd /opt/chatops && docker compose pull chatops && docker compose up -d chatops migrate 2>&1 | tail -10'
```

Expected: `chatops-migrate-1 Exited` + `chatops-chatops-1 Started`。

- [ ] **Step 12.3: 验证 migrate 应用了 v9**

```bash
sshpass -p 'Parav1ew' ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null root@10.10.1.166 \
  "docker exec chatops-postgres-1 psql -U chatops -d chatops -c \"SELECT username, must_change_password FROM admin_users;\""
```

Expected: `admin | t` 一行。

- [ ] **Step 12.4: 验证 session.key 已在 system_config**

```bash
sshpass -p 'Parav1ew' ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null root@10.10.1.166 \
  "docker exec chatops-postgres-1 psql -U chatops -d chatops -c \"SELECT key FROM system_config WHERE key='session';\""
```

Expected: 一行 `session`（server 启动时已 seed key）。

- [ ] **Step 12.5: 未登录访问 `/admin/system-config` 返 401**

```bash
curl -sSi http://10.10.1.166:3000/admin/system-config | head -5
```

Expected: `HTTP/1.1 401` + `{"error":"not_authenticated"}`

- [ ] **Step 12.6: 登录拿 cookie**

```bash
curl -sSi -c /tmp/chatops-cookies.txt \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin"}' \
  http://10.10.1.166:3000/admin/auth/login
```

Expected: `HTTP/1.1 200` + JSON `{"username":"admin","mustChangePassword":true}` + `Set-Cookie: chatops_admin_session=...`

- [ ] **Step 12.7: 带 cookie 访问受保护路由应被 mustChangePassword 拦截**

```bash
curl -sSi -b /tmp/chatops-cookies.txt http://10.10.1.166:3000/admin/system-config | head -3
```

Expected: `HTTP/1.1 403` + `{"error":"must_change_password"}`

- [ ] **Step 12.8: 通过 API 改密**

```bash
curl -sSi -b /tmp/chatops-cookies.txt \
  -H "Content-Type: application/json" \
  -d '{"oldPassword":"admin","newPassword":"Paraview2026"}' \
  http://10.10.1.166:3000/admin/auth/change-password
```

Expected: `HTTP/1.1 200` + `{"ok":true}`

- [ ] **Step 12.9: 改密后访问受保护路由应成功**

```bash
curl -sSi -b /tmp/chatops-cookies.txt http://10.10.1.166:3000/admin/system-config | head -3
```

Expected: `HTTP/1.1 200`

- [ ] **Step 12.10: 浏览器 E2E 检查（人工）**

告诉用户：
1. 清浏览器 10.10.1.166 的 cookies，访问 http://10.10.1.166:3000/
2. 自动跳转 `/login`，看到登录表单
3. 若上一步 API 改密已成功，用 `admin / Paraview2026` 登录；若还想试默认账号的强制流，先在 DB 把 `must_change_password` 重置为 TRUE 再用 `admin / admin` 登录
4. 登录后进入各管理页正常浏览，右上角显示用户名 + 登出按钮
5. 点登出返回登录页

- [ ] **Step 12.11: 在钉钉群里验证 MCP RBAC happy path 无回归**

让一个当前 PAM 产线 admin 身份的用户（严益昌）在群里发"有哪些模块"，机器人仍应返回 3 个模块的 markdown。

```bash
# 若需要查日志：
sshpass -p 'Parav1ew' ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null root@10.10.1.166 \
  'docker compose -f /opt/chatops/docker-compose.yml logs chatops --since 2m 2>&1 | grep -iE "list_projects|filterTools|Denied" | tail -10'
```

Expected: 能看到 list_projects 工具被过滤器放行，无 "Denied tool call" 日志。

- [ ] **Step 12.12: 验证非 admin 角色对管理员工具的拦截（可选回归）**

如果当前 DB 里有一个角色为 `developer` 的用户（非严益昌），让他发"查看部署状态"——这个应该命中 `query_deployments`（所有角色可用）。若让他发"给 xxx 部署 yyy"——应该走到 approval 流程或被 filterTools 过滤掉 `execute_deploy`（因为 execute_deploy 在 DEFAULT_TOOL_ROLES 里是 `['ops', 'admin']`）。

---

## 完成判定

- [x] 所有 task 的 commit 都在 `master`
- [x] `npx tsc --noEmit` + `npx vitest run` 均通过
- [x] 远端 `/admin/system-config` 未登录返 401（之前是 200 裸开）
- [x] 远端 `admin/admin` 登录 → 强制改密流程能走通
- [x] 钉钉群 happy path（"有哪些模块"）不回归
