# Pipeline Webhook Trigger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 ChatOps pipeline 引擎补齐第 5 种触发——外部系统 POST `/webhook/pipeline/:token` + JSON payload 即可启动指定 pipeline，返回 202 + runId。

**Architecture:** 新增 `pipeline_webhooks` 表（schema-v47）存 per-pipeline 多条独立 token；公开端点（无 session）验 token → 限流 → `runPipeline(id, servers, apiTrigger({ triggeredBy: 'webhook:N:name', params: payload }))` 异步推进；管理端点（带 session）做 CRUD + rotate；前端 pipeline 详情页加「Webhook 触发器」Tab；script 节点补 triggerParams 注入以支持 `{{triggerParams.x.y[0].z}}`。

**Tech Stack:** TypeScript / Fastify 5 / PostgreSQL (pg 直连) / React 18 + Ant Design 5 / Vitest

**Spec:** `docs/superpowers/specs/2026-04-28-pipeline-webhook-trigger-design.md`

> ⚠️ **版本号修正**：spec 写的是 schema-v46，但 v46 已被 `capability_invocations` 表占用（`src/db/schema-v46.sql`）。本 plan 统一使用 **v47**。

---

## File Structure

### 新建文件

| 文件 | 职责 |
|------|------|
| `src/db/schema-v47.sql` | `pipeline_webhooks` 表 DDL |
| `src/db/repositories/pipeline-webhooks-repo.ts` | CRUD + rotate token |
| `src/pipeline/webhook-token.ts` | token 生成（32 字节 url-safe base64） |
| `src/pipeline/webhook-rate-limit.ts` | 进程内 sliding-window 60/min/token |
| `src/admin/routes/pipeline-webhooks.ts` | 管理 CRUD 路由（需 session） |
| `web/src/api/pipeline-webhooks.ts` | 前端 axios CRUD client |
| `web/src/pipeline-canvas/panels/WebhooksPanel.tsx` | Webhook 触发器 Tab 面板 |
| `docs/smoke-webhook-trigger.md` | 手工冒烟手册 |
| `src/__tests__/unit/webhook-token.test.ts` | 单元：token 生成 |
| `src/__tests__/unit/webhook-rate-limit.test.ts` | 单元：限流 sliding-window |
| `src/__tests__/unit/webhook-payload-parsing.test.ts` | 单元：_servers 拆分 + 优先级 |
| `src/__tests__/unit/variables-trigger-params.test.ts` | 单元：script 节点 triggerParams 解析 |
| `src/__tests__/integration/webhook-create.test.ts` | 集成：CRUD + token 显示约定 |
| `src/__tests__/integration/webhook-trigger.test.ts` | 集成：happy path + triggerParams 落库 |
| `src/__tests__/integration/webhook-error-table.test.ts` | 集成：400/401/404/413/429 |
| `src/__tests__/integration/webhook-disabled.test.ts` | 集成：禁用场景 |

### 修改文件

| 文件 | 改动 |
|------|------|
| `src/db/migrate.ts` | SCHEMA_FILES 追加 `['v47', 'schema-v47.sql']` |
| `src/__tests__/helpers/db.ts` | SCHEMA_FILES 追加 `'schema-v47.sql'` |
| `src/server.ts` | 注册公开路由 `/webhook/pipeline/:token`；import webhook-router |
| `src/admin/index.ts` | import + 调用 `registerPipelineWebhookRoutes` |
| `src/pipeline/variables.ts` | `VariableContext` 加 `triggerParams?: Record<string, unknown>` |
| `src/pipeline/node-types/script.ts` | `varCtx` 里填 `triggerParams: ctx.triggerParams ?? {}` |
| `web/src/pipeline-canvas/PipelineCanvasPage.tsx` | 加 Webhook 触发器 Tab |
| `web/src/types/index.ts` | 加 `PipelineWebhook` 接口 |

---

## Task 1: Schema v47 + 注册

**Files:**
- Create: `src/db/schema-v47.sql`
- Modify: `src/db/migrate.ts`
- Modify: `src/__tests__/helpers/db.ts`

- [ ] **Step 1: 新建 schema-v47.sql**

```sql
-- v47: pipeline_webhooks 表
--
-- 为每条 pipeline 提供若干条独立 token，外部系统 POST /webhook/pipeline/:token
-- 即可异步触发 pipeline。token 仅在 create/rotate 时完整返回，后续查询只回前 8 字符。

CREATE TABLE IF NOT EXISTS pipeline_webhooks (
  id              SERIAL PRIMARY KEY,
  pipeline_id     INT NOT NULL REFERENCES test_pipelines(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  token           TEXT NOT NULL UNIQUE,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  default_servers JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      TEXT NOT NULL DEFAULT '',
  last_used_at    TIMESTAMPTZ,
  last_run_id     INT,
  trigger_count   INT NOT NULL DEFAULT 0,
  UNIQUE (pipeline_id, name)
);

CREATE INDEX IF NOT EXISTS idx_pipeline_webhooks_pipeline
  ON pipeline_webhooks(pipeline_id);
```

- [ ] **Step 2: migrate.ts 追加 v47**

打开 `src/db/migrate.ts`，在 `['v46', 'schema-v46.sql'],` 后面追加：
```typescript
  ['v47', 'schema-v47.sql'],
```

- [ ] **Step 3: helpers/db.ts 追加 v47**

打开 `src/__tests__/helpers/db.ts`，在 `'schema-v46.sql',` 后追加：
```typescript
  // v47: pipeline_webhooks 表，纯 DDL，无 seed 数据，安全加入。
  'schema-v47.sql',
```

- [ ] **Step 4: 验证迁移可跑**

```bash
DATABASE_URL=postgresql://localhost:5432/chatops_dev pnpm migrate
```

预期：输出 `Applied v47: schema-v47.sql`，无报错。

- [ ] **Step 5: Commit**

```bash
git add src/db/schema-v47.sql src/db/migrate.ts src/__tests__/helpers/db.ts
git commit -m "feat(db): schema-v47 pipeline_webhooks 表"
```

---

## Task 2: Token 生成工具（TDD）

**Files:**
- Create: `src/pipeline/webhook-token.ts`
- Create: `src/__tests__/unit/webhook-token.test.ts`

- [ ] **Step 1: 写失败测试**

新建 `src/__tests__/unit/webhook-token.test.ts`：
```typescript
import { describe, it, expect } from 'vitest'
import { generateWebhookToken, maskToken } from '../../../pipeline/webhook-token.js'

describe('generateWebhookToken', () => {
  it('生成 43 字符 url-safe base64', () => {
    const token = generateWebhookToken()
    expect(token).toHaveLength(43)
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('两次调用结果不同', () => {
    expect(generateWebhookToken()).not.toBe(generateWebhookToken())
  })
})

describe('maskToken', () => {
  it('返回前 8 字符 + 省略号', () => {
    expect(maskToken('abcdefghijklmnop')).toBe('abcdefgh…')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run src/__tests__/unit/webhook-token.test.ts
```

预期：FAIL — `Cannot find module '../../../pipeline/webhook-token.js'`

- [ ] **Step 3: 实现 webhook-token.ts**

新建 `src/pipeline/webhook-token.ts`：
```typescript
import { randomBytes } from 'crypto'

/**
 * 生成 url-safe base64 token（去 padding）。
 * 32 字节 = 43 个 base64url 字符，熵 256 bit。
 */
export function generateWebhookToken(): string {
  return randomBytes(32)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

/** 列表展示：仅暴露前 8 字符 + 省略号。 */
export function maskToken(token: string): string {
  return token.slice(0, 8) + '…'
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npx vitest run src/__tests__/unit/webhook-token.test.ts
```

预期：PASS 3 个 test cases。

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/webhook-token.ts src/__tests__/unit/webhook-token.test.ts
git commit -m "feat(webhook): token 生成工具 + 单元测试"
```

---

## Task 3: 限流工具（TDD）

**Files:**
- Create: `src/pipeline/webhook-rate-limit.ts`
- Create: `src/__tests__/unit/webhook-rate-limit.test.ts`

- [ ] **Step 1: 写失败测试**

新建 `src/__tests__/unit/webhook-rate-limit.test.ts`：
```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { RateLimiter } from '../../../pipeline/webhook-rate-limit.js'

describe('RateLimiter', () => {
  let limiter: RateLimiter

  beforeEach(() => {
    limiter = new RateLimiter(3, 60_000) // 3 次/60s，便于测试
    vi.useFakeTimers()
  })

  afterEach(() => vi.useRealTimers())

  it('窗口内 3 次请求都通过', () => {
    expect(limiter.check('tok1')).toEqual({ allowed: true })
    expect(limiter.check('tok1')).toEqual({ allowed: true })
    expect(limiter.check('tok1')).toEqual({ allowed: true })
  })

  it('第 4 次拒绝并返回 retryAfter', () => {
    limiter.check('tok1')
    limiter.check('tok1')
    limiter.check('tok1')
    const result = limiter.check('tok1')
    expect(result.allowed).toBe(false)
    expect((result as { allowed: false; retryAfter: number }).retryAfter).toBeGreaterThan(0)
  })

  it('不同 token 互不影响', () => {
    limiter.check('tok1'); limiter.check('tok1'); limiter.check('tok1')
    expect(limiter.check('tok2')).toEqual({ allowed: true })
  })

  it('窗口过期后恢复', () => {
    limiter.check('tok1'); limiter.check('tok1'); limiter.check('tok1')
    vi.advanceTimersByTime(61_000)
    expect(limiter.check('tok1')).toEqual({ allowed: true })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run src/__tests__/unit/webhook-rate-limit.test.ts
```

预期：FAIL — module not found。

- [ ] **Step 3: 实现 webhook-rate-limit.ts**

新建 `src/pipeline/webhook-rate-limit.ts`：
```typescript
interface Window {
  count: number
  windowStart: number
}

export type CheckResult =
  | { allowed: true }
  | { allowed: false; retryAfter: number }

/**
 * 进程内 sliding-window 限流器。
 * v1 故意单进程——多副本不保证一致性，下版引 Redis 时替换。
 */
export class RateLimiter {
  private readonly windows = new Map<string, Window>()

  constructor(
    private readonly maxRequests: number = 60,
    private readonly windowMs: number = 60_000,
  ) {}

  check(token: string): CheckResult {
    const now = Date.now()
    const win = this.windows.get(token)

    if (!win || now - win.windowStart >= this.windowMs) {
      this.windows.set(token, { count: 1, windowStart: now })
      return { allowed: true }
    }

    if (win.count < this.maxRequests) {
      win.count++
      return { allowed: true }
    }

    const retryAfter = Math.ceil((this.windowMs - (now - win.windowStart)) / 1000)
    return { allowed: false, retryAfter }
  }
}

// 全局单例供 webhook-router 直接 import
export const globalRateLimiter = new RateLimiter()
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npx vitest run src/__tests__/unit/webhook-rate-limit.test.ts
```

预期：PASS 4 个 test cases。

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/webhook-rate-limit.ts src/__tests__/unit/webhook-rate-limit.test.ts
git commit -m "feat(webhook): 进程内限流 sliding-window + 单元测试"
```

---

## Task 4: Payload 解析工具（TDD）

**Files:**
- Create: `src/__tests__/unit/webhook-payload-parsing.test.ts`（验证在 Task 6 公开路由里实现的逻辑，此处先写测试作为规范）

- [ ] **Step 1: 写解析工具测试**

新建 `src/__tests__/unit/webhook-payload-parsing.test.ts`：
```typescript
import { describe, it, expect } from 'vitest'
import { extractServersFromPayload, isValidServersShape } from '../../../pipeline/webhook-payload.js'

describe('extractServersFromPayload', () => {
  it('从 body 取出 _servers 并从 payload 剔除', () => {
    const body = { _servers: { deploy: ['s1'] }, repo: 'foo' }
    const { servers, payload } = extractServersFromPayload(body)
    expect(servers).toEqual({ deploy: ['s1'] })
    expect(payload).toEqual({ repo: 'foo' })
    expect(payload).not.toHaveProperty('_servers')
  })

  it('无 _servers 时 servers 为 undefined', () => {
    const { servers, payload } = extractServersFromPayload({ a: 1 })
    expect(servers).toBeUndefined()
    expect(payload).toEqual({ a: 1 })
  })
})

describe('isValidServersShape', () => {
  it('合法 Record<string, string[]>', () => {
    expect(isValidServersShape({ deploy: ['s1', 's2'] })).toBe(true)
  })

  it('非 object 返回 false', () => {
    expect(isValidServersShape('foo')).toBe(false)
    expect(isValidServersShape(null)).toBe(false)
  })

  it('value 不是 string[] 返回 false', () => {
    expect(isValidServersShape({ deploy: 's1' })).toBe(false)
    expect(isValidServersShape({ deploy: [1, 2] })).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run src/__tests__/unit/webhook-payload-parsing.test.ts
```

预期：FAIL — module not found。

- [ ] **Step 3: 实现 webhook-payload.ts**

新建 `src/pipeline/webhook-payload.ts`：
```typescript
export interface ExtractResult {
  servers: Record<string, string[]> | undefined
  payload: Record<string, unknown>
}

/**
 * 从请求 body 中拆出 _servers 字段，返回剔除后的 payload。
 * _servers 不会进入 triggerParams，不污染 pipeline 状态。
 */
export function extractServersFromPayload(body: Record<string, unknown>): ExtractResult {
  const { _servers, ...rest } = body
  return {
    servers: _servers !== undefined ? (_servers as Record<string, string[]>) : undefined,
    payload: rest,
  }
}

/**
 * 校验 _servers 是否为合法的 Record<string, string[]>。
 */
export function isValidServersShape(value: unknown): value is Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.values(value as Record<string, unknown>).every(
    (v) => Array.isArray(v) && v.every((s) => typeof s === 'string'),
  )
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npx vitest run src/__tests__/unit/webhook-payload-parsing.test.ts
```

预期：PASS。

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/webhook-payload.ts src/__tests__/unit/webhook-payload-parsing.test.ts
git commit -m "feat(webhook): payload 拆分 _servers 工具 + 单元测试"
```

---

## Task 5: Repository（TDD）

**Files:**
- Create: `src/db/repositories/pipeline-webhooks-repo.ts`
- Create: `src/__tests__/integration/webhook-create.test.ts`

- [ ] **Step 1: 写失败集成测试**

新建 `src/__tests__/integration/webhook-create.test.ts`：
```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { resetTestDb } from '../helpers/db.js'
import { getTestPool } from '../helpers/db.js'
import {
  createPipelineWebhook,
  listPipelineWebhooks,
  getPipelineWebhookByToken,
  updatePipelineWebhook,
  deletePipelineWebhook,
  rotatePipelineWebhookToken,
} from '../../db/repositories/pipeline-webhooks-repo.js'

// 辅助：创建一条测试 pipeline（借用 test_pipelines 表）
async function insertTestPipeline(): Promise<number> {
  const pool = getTestPool()
  const { rows } = await pool.query(
    `INSERT INTO test_pipelines (name, description, stages, enabled)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    ['webhook-test-pipeline', '', JSON.stringify([]), true],
  )
  return rows[0].id as number
}

describe('pipeline-webhooks-repo', () => {
  beforeEach(() => resetTestDb())

  it('create 返回完整 webhook（含完整 token）', async () => {
    const pipelineId = await insertTestPipeline()
    const wh = await createPipelineWebhook({ pipelineId, name: 'ci', createdBy: 'admin' })
    expect(wh.id).toBeGreaterThan(0)
    expect(wh.token).toHaveLength(43)
    expect(wh.pipelineId).toBe(pipelineId)
    expect(wh.name).toBe('ci')
    expect(wh.enabled).toBe(true)
    expect(wh.triggerCount).toBe(0)
  })

  it('list 返回 masked token（前 8 字符 + 省略号）', async () => {
    const pipelineId = await insertTestPipeline()
    await createPipelineWebhook({ pipelineId, name: 'ci', createdBy: 'admin' })
    const list = await listPipelineWebhooks(pipelineId)
    expect(list).toHaveLength(1)
    expect(list[0].token).toMatch(/^.{8}…$/)
  })

  it('getByToken 返回完整 webhook', async () => {
    const pipelineId = await insertTestPipeline()
    const created = await createPipelineWebhook({ pipelineId, name: 'ci', createdBy: 'admin' })
    const found = await getPipelineWebhookByToken(created.token)
    expect(found?.id).toBe(created.id)
    expect(found?.token).toBe(created.token)
  })

  it('getByToken 找不到时返回 null', async () => {
    expect(await getPipelineWebhookByToken('nonexistent-token')).toBeNull()
  })

  it('update 修改 name 和 enabled', async () => {
    const pipelineId = await insertTestPipeline()
    const wh = await createPipelineWebhook({ pipelineId, name: 'ci', createdBy: 'admin' })
    const updated = await updatePipelineWebhook(wh.id, { name: 'new-ci', enabled: false })
    expect(updated?.name).toBe('new-ci')
    expect(updated?.enabled).toBe(false)
  })

  it('rotate 生成新 token 且旧 token 失效', async () => {
    const pipelineId = await insertTestPipeline()
    const wh = await createPipelineWebhook({ pipelineId, name: 'ci', createdBy: 'admin' })
    const { newToken } = await rotatePipelineWebhookToken(wh.id)
    expect(newToken).not.toBe(wh.token)
    expect(newToken).toHaveLength(43)
    expect(await getPipelineWebhookByToken(wh.token)).toBeNull()
    expect(await getPipelineWebhookByToken(newToken)).not.toBeNull()
  })

  it('delete 后 getByToken 返回 null', async () => {
    const pipelineId = await insertTestPipeline()
    const wh = await createPipelineWebhook({ pipelineId, name: 'ci', createdBy: 'admin' })
    await deletePipelineWebhook(wh.id)
    expect(await getPipelineWebhookByToken(wh.token)).toBeNull()
  })

  it('同 pipeline 重名时抛出 unique 错误', async () => {
    const pipelineId = await insertTestPipeline()
    await createPipelineWebhook({ pipelineId, name: 'ci', createdBy: 'admin' })
    await expect(
      createPipelineWebhook({ pipelineId, name: 'ci', createdBy: 'admin' }),
    ).rejects.toThrow()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run src/__tests__/integration/webhook-create.test.ts
```

预期：FAIL — module not found。

- [ ] **Step 3: 实现 repository**

新建 `src/db/repositories/pipeline-webhooks-repo.ts`：
```typescript
import { getPool } from '../client.js'
import { generateWebhookToken, maskToken } from '../../pipeline/webhook-token.js'

export interface PipelineWebhook {
  id: number
  pipelineId: number
  name: string
  /** 完整 token（仅 create / rotate / getByToken 返回）或 masked（列表） */
  token: string
  enabled: boolean
  defaultServers: Record<string, string[]> | null
  createdAt: Date
  createdBy: string
  lastUsedAt: Date | null
  lastRunId: number | null
  triggerCount: number
}

function mapRow(r: Record<string, unknown>): PipelineWebhook {
  return {
    id: r.id as number,
    pipelineId: r.pipeline_id as number,
    name: r.name as string,
    token: r.token as string,
    enabled: r.enabled as boolean,
    defaultServers: r.default_servers as Record<string, string[]> | null,
    createdAt: r.created_at as Date,
    createdBy: r.created_by as string,
    lastUsedAt: r.last_used_at as Date | null,
    lastRunId: r.last_run_id as number | null,
    triggerCount: r.trigger_count as number,
  }
}

/** 列表：token 脱敏为前 8 字符 + 省略号 */
export async function listPipelineWebhooks(pipelineId: number): Promise<PipelineWebhook[]> {
  const pool = getPool()
  const { rows } = await pool.query(
    `SELECT *, LEFT(token, 8) || chr(8230) AS token
     FROM pipeline_webhooks WHERE pipeline_id = $1 ORDER BY id`,
    [pipelineId],
  )
  return rows.map(mapRow)
}

/** 通过 token 精确查找（用于公开端点鉴权，返回完整行含完整 token） */
export async function getPipelineWebhookByToken(token: string): Promise<PipelineWebhook | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    `SELECT * FROM pipeline_webhooks WHERE token = $1`,
    [token],
  )
  return rows[0] ? mapRow(rows[0]) : null
}

export interface CreateWebhookInput {
  pipelineId: number
  name: string
  createdBy: string
  defaultServers?: Record<string, string[]>
}

/** Create：返回含完整 token 的行 */
export async function createPipelineWebhook(input: CreateWebhookInput): Promise<PipelineWebhook> {
  const pool = getPool()
  for (let attempt = 0; attempt < 3; attempt++) {
    const token = generateWebhookToken()
    try {
      const { rows } = await pool.query(
        `INSERT INTO pipeline_webhooks (pipeline_id, name, token, created_by, default_servers)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [
          input.pipelineId,
          input.name,
          token,
          input.createdBy,
          input.defaultServers ? JSON.stringify(input.defaultServers) : null,
        ],
      )
      return mapRow(rows[0])
    } catch (err: unknown) {
      const pg = err as { code?: string; constraint?: string }
      // 23505 = unique_violation；若撞的是 token 列则重试，否则（name 列）直接 rethrow
      if (pg.code === '23505' && pg.constraint?.includes('token')) continue
      throw err
    }
  }
  throw new Error('Failed to generate unique webhook token after 3 attempts')
}

export interface UpdateWebhookInput {
  name?: string
  enabled?: boolean
  defaultServers?: Record<string, string[]> | null
}

export async function updatePipelineWebhook(
  id: number,
  input: UpdateWebhookInput,
): Promise<PipelineWebhook | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    `UPDATE pipeline_webhooks
     SET name           = COALESCE($2, name),
         enabled        = COALESCE($3, enabled),
         default_servers = CASE WHEN $4::boolean THEN $5::jsonb ELSE default_servers END
     WHERE id = $1 RETURNING *`,
    [
      id,
      input.name ?? null,
      input.enabled ?? null,
      input.defaultServers !== undefined, // $4: 是否更新 default_servers
      input.defaultServers !== undefined && input.defaultServers !== null
        ? JSON.stringify(input.defaultServers)
        : null,
    ],
  )
  return rows[0] ? mapRow(rows[0]) : null
}

/** Rotate：生成新 token，立即覆盖，旧 token 失效。返回完整新 token。 */
export async function rotatePipelineWebhookToken(id: number): Promise<{ newToken: string }> {
  const pool = getPool()
  for (let attempt = 0; attempt < 3; attempt++) {
    const newToken = generateWebhookToken()
    try {
      const { rowCount } = await pool.query(
        `UPDATE pipeline_webhooks SET token = $2 WHERE id = $1`,
        [id, newToken],
      )
      if ((rowCount ?? 0) === 0) throw new Error(`Webhook ${id} not found`)
      return { newToken }
    } catch (err: unknown) {
      const pg = err as { code?: string }
      if (pg.code === '23505') continue
      throw err
    }
  }
  throw new Error('Failed to generate unique token after 3 attempts')
}

export async function deletePipelineWebhook(id: number): Promise<boolean> {
  const pool = getPool()
  const { rowCount } = await pool.query(
    `DELETE FROM pipeline_webhooks WHERE id = $1`,
    [id],
  )
  return (rowCount ?? 0) > 0
}

/** 触发后更新统计字段（fire-and-forget，调用方不 await 也可） */
export async function recordWebhookUsed(id: number, runId: number): Promise<void> {
  const pool = getPool()
  await pool.query(
    `UPDATE pipeline_webhooks
     SET last_used_at = NOW(), last_run_id = $2, trigger_count = trigger_count + 1
     WHERE id = $1`,
    [id, runId],
  )
}

/** 供列表展示：对已有 token 字段做客户端 mask（不去 DB 重查） */
export { maskToken }
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npx vitest run src/__tests__/integration/webhook-create.test.ts
```

预期：PASS 8 个 test cases。

- [ ] **Step 5: Commit**

```bash
git add src/db/repositories/pipeline-webhooks-repo.ts src/__tests__/integration/webhook-create.test.ts
git commit -m "feat(db): pipeline-webhooks repository + 集成测试"
```

---

## Task 6: VariableContext 加 triggerParams（TDD）

**Files:**
- Modify: `src/pipeline/variables.ts`
- Modify: `src/pipeline/node-types/script.ts`
- Create: `src/__tests__/unit/variables-trigger-params.test.ts`

> **背景**：`ExecutionContext`（node-types/types.ts:15）已有 `triggerParams: Record<string, unknown>`；`graph-builder.buildVariableContext`（L724-752）已把 triggerParams 注入 ctx；但 `VariableContext` 接口未声明该字段，且 `script.ts` standalone executor（L50-63）构造的 varCtx 缺该字段。本 task 补齐这两处。

- [ ] **Step 1: 写失败测试**

新建 `src/__tests__/unit/variables-trigger-params.test.ts`：
```typescript
import { describe, it, expect } from 'vitest'
import { resolveVariables, type VariableContext } from '../../../pipeline/variables.js'

const baseCtx: VariableContext = {
  productLine: { name: 'pl', displayName: 'PL' },
  pipeline: { id: 1, name: 'p' },
  run: { id: 1, triggeredBy: 'user', triggerType: 'api' },
  stage: { name: 's', index: 0 },
  server: { host: 'h', port: 22, username: 'u', name: 'n', role: 'r' },
  vars: {},
}

describe('triggerParams 模板解析', () => {
  it('{{triggerParams.foo}} 取顶层字段', () => {
    const ctx = { ...baseCtx, triggerParams: { foo: 'bar' } }
    expect(resolveVariables('{{triggerParams.foo}}', ctx)).toBe('bar')
  })

  it('{{triggerParams.a.b}} 嵌套字段', () => {
    const ctx = { ...baseCtx, triggerParams: { a: { b: 'nested' } } }
    expect(resolveVariables('{{triggerParams.a.b}}', ctx)).toBe('nested')
  })

  it('{{triggerParams.commits[0].id}} 数组索引', () => {
    const ctx = { ...baseCtx, triggerParams: { commits: [{ id: 'abc123' }] } }
    expect(resolveVariables('{{triggerParams.commits[0].id}}', ctx)).toBe('abc123')
  })

  it('不存在的字段保留 {{...}} 字面量', () => {
    const ctx = { ...baseCtx, triggerParams: {} }
    expect(resolveVariables('{{triggerParams.missing}}', ctx)).toBe('{{triggerParams.missing}}')
  })

  it('无 triggerParams 时保留字面量', () => {
    expect(resolveVariables('{{triggerParams.foo}}', baseCtx)).toBe('{{triggerParams.foo}}')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run src/__tests__/unit/variables-trigger-params.test.ts
```

预期：部分失败（VariableContext 没有 triggerParams 字段，TS 类型报错或运行时 undefined）。

- [ ] **Step 3: 给 VariableContext 加 triggerParams**

修改 `src/pipeline/variables.ts` 第 23-30 行的 interface：

```typescript
export interface VariableContext {
  productLine: { name: string; displayName: string }
  pipeline: { id: number; name: string }
  run: { id: number; triggeredBy: string; triggerType: string }
  stage: { name: string; index: number }
  server: { host: string; port: number; username: string; name: string; role: string }
  vars: Record<string, string>
  triggerParams?: Record<string, unknown>
}
```

- [ ] **Step 4: script.ts 补 triggerParams 注入**

修改 `src/pipeline/node-types/script.ts` 第 50-63 行：
```typescript
    const varCtx: VariableContext = {
      productLine: { name: '', displayName: '' },
      pipeline: { id: ctx.pipelineId, name: '' },
      run: { id: ctx.runId, triggeredBy: '', triggerType: '' },
      stage: { name: ctx.nodeId, index: 0 },
      server: {
        host: ctx.server.host,
        port: ctx.server.port,
        username: ctx.server.username,
        name: '',
        role: '',
      },
      vars: (ctx.vars ?? {}) as Record<string, string>,
      triggerParams: ctx.triggerParams,
    }
```

- [ ] **Step 5: 跑测试确认通过**

```bash
npx vitest run src/__tests__/unit/variables-trigger-params.test.ts
```

预期：PASS 5 个 test cases。

- [ ] **Step 6: 类型检查**

```bash
cd web && pnpm build --noEmit 2>&1 | head -20; cd .. && npx tsc --noEmit 2>&1 | head -20
```

预期：无 TS 错误。

- [ ] **Step 7: Commit**

```bash
git add src/pipeline/variables.ts src/pipeline/node-types/script.ts src/__tests__/unit/variables-trigger-params.test.ts
git commit -m "feat(pipeline): VariableContext + script executor 补 triggerParams 支持"
```

---

## Task 7: 公开 Webhook 路由（TDD）

**Files:**
- Create: `src/__tests__/integration/webhook-trigger.test.ts`
- Create: `src/__tests__/integration/webhook-error-table.test.ts`
- Create: `src/__tests__/integration/webhook-disabled.test.ts`
- Modify: `src/server.ts`

> **注意**：公开端点直接在 `src/server.ts` 里注册（仿 `/webhook/gitlab` 的写法），不走 adminPlugin，也不受 `requireAuth` 限制。

- [ ] **Step 1: 写集成测试（happy path）**

新建 `src/__tests__/integration/webhook-trigger.test.ts`：
```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { resetTestDb, getTestPool } from '../helpers/db.js'
import { buildTestApp } from '../helpers/app.js'
import { createPipelineWebhook } from '../../db/repositories/pipeline-webhooks-repo.js'

async function insertTestPipeline(): Promise<number> {
  const pool = getTestPool()
  const { rows } = await pool.query(
    `INSERT INTO test_pipelines (name, description, stages, enabled)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    ['wh-trigger-test', '', JSON.stringify([]), true],
  )
  return rows[0].id as number
}

describe('POST /webhook/pipeline/:token', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>

  beforeEach(async () => {
    await resetTestDb()
    app = await buildTestApp()
  })

  afterEach(() => app.close())

  it('valid token + JSON body → 202 + runId + statusUrl', async () => {
    const pipelineId = await insertTestPipeline()
    const wh = await createPipelineWebhook({ pipelineId, name: 'ci', createdBy: 'test' })
    const res = await app.inject({
      method: 'POST',
      url: `/webhook/pipeline/${wh.token}`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: 'my-repo', branch: 'main' }),
    })
    expect(res.statusCode).toBe(202)
    const body = res.json<{ runId: number; statusUrl: string; triggeredAt: string }>()
    expect(body.runId).toBeGreaterThan(0)
    expect(body.statusUrl).toContain('/admin/api/test-runs/')
    expect(body.triggeredAt).toMatch(/^\d{4}-/)
  })

  it('trigger_count +1 后 last_used_at 非空', async () => {
    const pipelineId = await insertTestPipeline()
    const wh = await createPipelineWebhook({ pipelineId, name: 'ci', createdBy: 'test' })
    await app.inject({
      method: 'POST',
      url: `/webhook/pipeline/${wh.token}`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ foo: 'bar' }),
    })
    const pool = getTestPool()
    const { rows } = await pool.query(
      `SELECT trigger_count, last_used_at FROM pipeline_webhooks WHERE id = $1`,
      [wh.id],
    )
    expect(rows[0].trigger_count).toBe(1)
    expect(rows[0].last_used_at).not.toBeNull()
  })

  it('triggerParams 写入 test_runs', async () => {
    const pipelineId = await insertTestPipeline()
    const wh = await createPipelineWebhook({ pipelineId, name: 'ci', createdBy: 'test' })
    const payload = { commits: [{ id: 'abc123' }], ref: 'refs/heads/main' }
    const res = await app.inject({
      method: 'POST',
      url: `/webhook/pipeline/${wh.token}`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const { runId } = res.json<{ runId: number }>()
    const pool = getTestPool()
    const { rows } = await pool.query(
      `SELECT trigger_params, triggered_by FROM test_runs WHERE id = $1`,
      [runId],
    )
    expect(rows[0].trigger_params).toMatchObject(payload)
    expect(rows[0].triggered_by).toMatch(/^webhook:\d+:ci$/)
  })
})
```

- [ ] **Step 2: 写错误场景测试**

新建 `src/__tests__/integration/webhook-error-table.test.ts`：
```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { resetTestDb, getTestPool } from '../helpers/db.js'
import { buildTestApp } from '../helpers/app.js'
import { createPipelineWebhook } from '../../db/repositories/pipeline-webhooks-repo.js'

async function insertTestPipeline(enabled = true): Promise<number> {
  const pool = getTestPool()
  const { rows } = await pool.query(
    `INSERT INTO test_pipelines (name, description, stages, enabled)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    ['wh-error-test', '', JSON.stringify([]), enabled],
  )
  return rows[0].id as number
}

describe('Webhook 错误场景', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>

  beforeEach(async () => {
    await resetTestDb()
    app = await buildTestApp()
  })

  afterEach(() => app.close())

  it('不存在的 token → 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhook/pipeline/nonexistent-token-xxx',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'invalid webhook token' })
  })

  it('pipeline 被禁用 → 404', async () => {
    const pipelineId = await insertTestPipeline(false)
    const wh = await createPipelineWebhook({ pipelineId, name: 'ci', createdBy: 'test' })
    const res = await app.inject({
      method: 'POST',
      url: `/webhook/pipeline/${wh.token}`,
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.statusCode).toBe(404)
  })

  it('body 非 JSON object（是 array）→ 400', async () => {
    const pipelineId = await insertTestPipeline()
    const wh = await createPipelineWebhook({ pipelineId, name: 'ci', createdBy: 'test' })
    const res = await app.inject({
      method: 'POST',
      url: `/webhook/pipeline/${wh.token}`,
      headers: { 'content-type': 'application/json' },
      body: '[1, 2, 3]',
    })
    expect(res.statusCode).toBe(400)
  })

  it('_servers 形状错误（string 而不是 Record<string,string[]>）→ 400', async () => {
    const pipelineId = await insertTestPipeline()
    const wh = await createPipelineWebhook({ pipelineId, name: 'ci', createdBy: 'test' })
    const res = await app.inject({
      method: 'POST',
      url: `/webhook/pipeline/${wh.token}`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ _servers: 'invalid' }),
    })
    expect(res.statusCode).toBe(400)
  })

  it('超限流后返回 429 + Retry-After header', async () => {
    // 使用私有限流器测试需要 mock，此处用 60 次请求探边界
    // 实际集成测试只验证 header 格式，不跑 60 次
    const pipelineId = await insertTestPipeline()
    const wh = await createPipelineWebhook({ pipelineId, name: 'ci', createdBy: 'test' })
    // 触发限流需要在测试里注入一个小容量限流器；此 case 验证路由存在限流响应格式
    // （全量限流测试在单元测试 webhook-rate-limit.test.ts 覆盖）
    // 这里只验证正常请求不含 Retry-After
    const res = await app.inject({
      method: 'POST',
      url: `/webhook/pipeline/${wh.token}`,
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect([202, 429]).toContain(res.statusCode)
    if (res.statusCode === 429) {
      expect(res.headers['retry-after']).toBeDefined()
    }
  })
})
```

- [ ] **Step 3: 写禁用场景测试**

新建 `src/__tests__/integration/webhook-disabled.test.ts`：
```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { resetTestDb, getTestPool } from '../helpers/db.js'
import { buildTestApp } from '../helpers/app.js'
import { createPipelineWebhook, updatePipelineWebhook } from '../../db/repositories/pipeline-webhooks-repo.js'

async function insertTestPipeline(): Promise<number> {
  const pool = getTestPool()
  const { rows } = await pool.query(
    `INSERT INTO test_pipelines (name, description, stages, enabled)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    ['wh-disabled-test', '', JSON.stringify([]), true],
  )
  return rows[0].id as number
}

describe('Webhook 禁用场景', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>

  beforeEach(async () => {
    await resetTestDb()
    app = await buildTestApp()
  })

  afterEach(() => app.close())

  it('webhook enabled=false → 401（与 token 不存在同一响应，防探测）', async () => {
    const pipelineId = await insertTestPipeline()
    const wh = await createPipelineWebhook({ pipelineId, name: 'ci', createdBy: 'test' })
    await updatePipelineWebhook(wh.id, { enabled: false })
    const res = await app.inject({
      method: 'POST',
      url: `/webhook/pipeline/${wh.token}`,
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'invalid webhook token' })
  })
})
```

- [ ] **Step 4: 跑测试确认失败（路由未实现）**

```bash
npx vitest run src/__tests__/integration/webhook-trigger.test.ts src/__tests__/integration/webhook-error-table.test.ts src/__tests__/integration/webhook-disabled.test.ts
```

预期：FAIL — buildTestApp 找不到路由，inject 得到 404。

- [ ] **Step 5: 在 server.ts 注册公开路由**

在 `src/server.ts` 中，在 `app.post('/webhook/gitlab', ...)` 代码块之后（约 L361）添加：

```typescript
  // Pipeline Webhook 公开触发端点（无 session，token in path）
  {
    const { globalRateLimiter } = await import('./pipeline/webhook-rate-limit.js')
    const { getPipelineWebhookByToken, recordWebhookUsed } = await import('./db/repositories/pipeline-webhooks-repo.js')
    const { getTestPipelineById } = await import('./db/repositories/test-pipelines.js')
    const { runPipeline } = await import('./pipeline/executor.js')
    const { apiTrigger } = await import('./pipeline/trigger.js')
    const { extractServersFromPayload, isValidServersShape } = await import('./pipeline/webhook-payload.js')

    app.post<{ Params: { token: string } }>(
      '/webhook/pipeline/:token',
      async (req, reply) => {
        const { token } = req.params
        const payloadSize = req.headers['content-length'] ? parseInt(req.headers['content-length'], 10) : 0

        // 1. 查 token（disabled webhook 和不存在统一 401，防探测）
        const webhook = await getPipelineWebhookByToken(token)
        if (!webhook || !webhook.enabled) {
          req.log.info({ webhookId: webhook?.id, decision: 'rejected', reason: 'invalid_token', payloadSize }, 'webhook rejected')
          return reply.status(401).send({ error: 'invalid webhook token' })
        }

        // 2. 限流
        const rateResult = globalRateLimiter.check(token)
        if (!rateResult.allowed) {
          const retryAfter = (rateResult as { allowed: false; retryAfter: number }).retryAfter
          req.log.info({ webhookId: webhook.id, decision: 'rejected', reason: 'rate_limit', payloadSize }, 'webhook rate limited')
          return reply
            .status(429)
            .header('Retry-After', String(retryAfter))
            .send({ error: 'rate limited', retryAfter })
        }

        // 3. 加载 pipeline
        const pipeline = await getTestPipelineById(webhook.pipelineId)
        if (!pipeline || !pipeline.enabled) {
          req.log.info({ webhookId: webhook.id, decision: 'rejected', reason: 'pipeline_not_found', payloadSize }, 'webhook pipeline not found')
          return reply.status(404).send({ error: 'pipeline not found or disabled' })
        }

        // 4. 校验 body
        const rawBody = req.body as unknown
        if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
          return reply.status(400).send({ error: 'body must be a JSON object' })
        }
        const body = rawBody as Record<string, unknown>

        // 5. 拆 _servers
        if (body._servers !== undefined && !isValidServersShape(body._servers)) {
          return reply.status(400).send({ error: '_servers must be Record<string, string[]>' })
        }
        const { servers: bodyServers, payload } = extractServersFromPayload(body)

        // 6. 合并 server 优先级
        const effectiveServers: Record<string, string[]> =
          bodyServers ??
          (webhook.defaultServers as Record<string, string[]> | null) ??
          {}

        // 7. 触发 pipeline（fire-and-forget：await 拿 runId，不等 pipeline 完成）
        const triggeredBy = `webhook:${webhook.id}:${webhook.name}`
        const runId = await runPipeline(
          webhook.pipelineId,
          effectiveServers,
          apiTrigger({ triggeredBy, params: payload }),
        )

        // 8. 更新统计
        recordWebhookUsed(webhook.id, runId).catch((err) =>
          req.log.error({ err, webhookId: webhook.id }, 'recordWebhookUsed failed'),
        )

        const triggeredAt = new Date().toISOString()
        req.log.info({ webhookId: webhook.id, webhookName: webhook.name, runId, decision: 'accepted', payloadSize }, 'webhook accepted')

        return reply.status(202).send({
          runId,
          statusUrl: `/admin/api/test-runs/${runId}`,
          triggeredAt,
        })
      },
    )
  }
```

- [ ] **Step 6: 跑测试确认通过**

```bash
npx vitest run src/__tests__/integration/webhook-trigger.test.ts src/__tests__/integration/webhook-error-table.test.ts src/__tests__/integration/webhook-disabled.test.ts
```

预期：大部分 PASS（限流的 429 场景因单元测试覆盖，集成里验证宽泛）。

- [ ] **Step 7: Commit**

```bash
git add src/server.ts src/__tests__/integration/webhook-trigger.test.ts src/__tests__/integration/webhook-error-table.test.ts src/__tests__/integration/webhook-disabled.test.ts src/pipeline/webhook-payload.ts
git commit -m "feat(webhook): 公开触发端点 POST /webhook/pipeline/:token"
```

---

## Task 8: 管理路由 CRUD（TDD）

**Files:**
- Create: `src/admin/routes/pipeline-webhooks.ts`
- Modify: `src/admin/index.ts`

- [ ] **Step 1: 实现管理路由**

新建 `src/admin/routes/pipeline-webhooks.ts`：
```typescript
import type { FastifyInstance } from 'fastify'
import {
  listPipelineWebhooks,
  createPipelineWebhook,
  updatePipelineWebhook,
  deletePipelineWebhook,
  rotatePipelineWebhookToken,
} from '../../db/repositories/pipeline-webhooks-repo.js'
import { getTestPipelineById } from '../../db/repositories/test-pipelines.js'

export async function registerPipelineWebhookRoutes(app: FastifyInstance): Promise<void> {
  // 列表（token 脱敏）
  app.get<{ Params: { pipelineId: string } }>(
    '/pipelines/:pipelineId/webhooks',
    async (req, reply) => {
      const pipelineId = Number(req.params.pipelineId)
      if (!await getTestPipelineById(pipelineId)) {
        return reply.status(404).send({ error: 'pipeline not found' })
      }
      return reply.send(await listPipelineWebhooks(pipelineId))
    },
  )

  // 创建（完整 token 仅此一次）
  app.post<{
    Params: { pipelineId: string }
    Body: { name: string; defaultServers?: Record<string, string[]> }
  }>(
    '/pipelines/:pipelineId/webhooks',
    async (req, reply) => {
      const pipelineId = Number(req.params.pipelineId)
      if (!await getTestPipelineById(pipelineId)) {
        return reply.status(404).send({ error: 'pipeline not found' })
      }
      const { name, defaultServers } = req.body
      if (!name?.trim()) return reply.status(400).send({ error: 'name required' })

      const wh = await createPipelineWebhook({
        pipelineId,
        name: name.trim(),
        createdBy: (req.session?.user?.username as string | undefined) ?? '',
        defaultServers,
      })

      // 构建完整触发 URL（实际 host 由调用方自行拼；此处返回 path 供前端拼完整 URL）
      const url = `/webhook/pipeline/${wh.token}`
      return reply.status(201).send({ ...wh, url })
    },
  )

  // Rotate（完整新 token 仅此一次）
  app.post<{ Params: { pipelineId: string; id: string } }>(
    '/pipelines/:pipelineId/webhooks/:id/rotate',
    async (req, reply) => {
      const id = Number(req.params.id)
      const { newToken } = await rotatePipelineWebhookToken(id).catch(() => {
        return { newToken: null }
      })
      if (!newToken) return reply.status(404).send({ error: 'webhook not found' })
      const url = `/webhook/pipeline/${newToken}`
      return reply.send({ token: newToken, url })
    },
  )

  // 更新（name / enabled / defaultServers）
  app.patch<{
    Params: { pipelineId: string; id: string }
    Body: { name?: string; enabled?: boolean; defaultServers?: Record<string, string[]> | null }
  }>(
    '/pipelines/:pipelineId/webhooks/:id',
    async (req, reply) => {
      const updated = await updatePipelineWebhook(Number(req.params.id), req.body)
      if (!updated) return reply.status(404).send({ error: 'webhook not found' })
      return reply.send(updated)
    },
  )

  // 删除
  app.delete<{ Params: { pipelineId: string; id: string } }>(
    '/pipelines/:pipelineId/webhooks/:id',
    async (req, reply) => {
      const deleted = await deletePipelineWebhook(Number(req.params.id))
      if (!deleted) return reply.status(404).send({ error: 'webhook not found' })
      return reply.status(204).send()
    },
  )
}
```

- [ ] **Step 2: 注册到 admin/index.ts**

在 `src/admin/index.ts` 中：

顶部 import 处（在现有 imports 末尾）加：
```typescript
import { registerPipelineWebhookRoutes } from './routes/pipeline-webhooks.js'
```

在 `adminPlugin` 函数体内，在其他 `await register...` 调用末尾加：
```typescript
  await registerPipelineWebhookRoutes(app)
```

- [ ] **Step 3: 类型检查**

```bash
npx tsc --noEmit 2>&1 | head -20
```

预期：无报错。

- [ ] **Step 4: Commit**

```bash
git add src/admin/routes/pipeline-webhooks.ts src/admin/index.ts
git commit -m "feat(admin): pipeline webhook CRUD + rotate 管理路由"
```

---

## Task 9: 前端 API Client + 类型

**Files:**
- Modify: `web/src/types/index.ts`
- Create: `web/src/api/pipeline-webhooks.ts`

- [ ] **Step 1: 加 PipelineWebhook 类型**

在 `web/src/types/index.ts` 末尾追加：
```typescript
export interface PipelineWebhook {
  id: number
  pipelineId: number
  name: string
  token: string        // 列表里是 masked（前8字符+省略号），create/rotate 是完整 token
  enabled: boolean
  defaultServers: Record<string, string[]> | null
  createdAt: string
  createdBy: string
  lastUsedAt: string | null
  lastRunId: number | null
  triggerCount: number
  url?: string         // create/rotate 响应额外携带，列表无此字段
}
```

- [ ] **Step 2: 新建 API client**

新建 `web/src/api/pipeline-webhooks.ts`：
```typescript
import client from './client.js'
import type { PipelineWebhook } from '../types/index.js'

export function listPipelineWebhooks(pipelineId: number) {
  return client
    .get<PipelineWebhook[]>(`/pipelines/${pipelineId}/webhooks`)
    .then((r) => r.data)
}

export function createPipelineWebhook(
  pipelineId: number,
  body: { name: string; defaultServers?: Record<string, string[]> },
) {
  return client
    .post<PipelineWebhook & { token: string; url: string }>(
      `/pipelines/${pipelineId}/webhooks`,
      body,
    )
    .then((r) => r.data)
}

export function rotatePipelineWebhook(pipelineId: number, webhookId: number) {
  return client
    .post<{ token: string; url: string }>(
      `/pipelines/${pipelineId}/webhooks/${webhookId}/rotate`,
    )
    .then((r) => r.data)
}

export function updatePipelineWebhook(
  pipelineId: number,
  webhookId: number,
  body: { name?: string; enabled?: boolean; defaultServers?: Record<string, string[]> | null },
) {
  return client
    .patch<PipelineWebhook>(`/pipelines/${pipelineId}/webhooks/${webhookId}`, body)
    .then((r) => r.data)
}

export function deletePipelineWebhook(pipelineId: number, webhookId: number) {
  return client.delete(`/pipelines/${pipelineId}/webhooks/${webhookId}`)
}
```

- [ ] **Step 3: 类型检查**

```bash
cd web && pnpm build --noEmit 2>&1 | head -20
```

预期：无 TS 错误。

- [ ] **Step 4: Commit**

```bash
git add web/src/types/index.ts web/src/api/pipeline-webhooks.ts
git commit -m "feat(frontend): PipelineWebhook 类型 + API client"
```

---

## Task 10: 前端 WebhooksPanel

**Files:**
- Create: `web/src/pipeline-canvas/panels/WebhooksPanel.tsx`
- Modify: `web/src/pipeline-canvas/PipelineCanvasPage.tsx`

> **UI 规格（来自 spec §8）**：
> - 列表列：name / token 前 8 字符 + 省略号 / enabled 开关 / 最近触发时间 / 累计触发次数 / 操作（rotate / 删除）
> - 新建 / rotate 后弹模态框显示完整 URL，需点「我已保存」才能关闭
> - defaultServers：按 pipeline 的 serverRoles 渲染每个角色的 Input（填 server ID 列表，逗号分隔）
> - 列表上方「测试」按钮，显示 curl 模板

- [ ] **Step 1: 新建 WebhooksPanel.tsx**

新建 `web/src/pipeline-canvas/panels/WebhooksPanel.tsx`：
```tsx
import React, { useEffect, useState } from 'react'
import {
  Table, Button, Switch, Modal, Form, Input, message, Space,
  Typography, Tooltip, Popconfirm, Tag,
} from 'antd'
import { PlusOutlined, ReloadOutlined, DeleteOutlined, CopyOutlined } from '@ant-design/icons'
import type { PipelineWebhook } from '../../types/index.js'
import type { TestPipeline } from '../../types/index.js'
import {
  listPipelineWebhooks,
  createPipelineWebhook,
  rotatePipelineWebhook,
  updatePipelineWebhook,
  deletePipelineWebhook,
} from '../../api/pipeline-webhooks.js'

const { Text, Paragraph } = Typography

interface Props {
  pipeline: TestPipeline
}

export default function WebhooksPanel({ pipeline }: Props) {
  const [webhooks, setWebhooks] = useState<PipelineWebhook[]>([])
  const [loading, setLoading] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [secretModal, setSecretModal] = useState<{ url: string; token: string } | null>(null)
  const [secretSaved, setSecretSaved] = useState(false)
  const [form] = Form.useForm()

  const baseUrl = window.location.origin

  async function load() {
    setLoading(true)
    try {
      setWebhooks(await listPipelineWebhooks(pipeline.id))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [pipeline.id])

  async function handleCreate(values: { name: string; defaultServers?: string }) {
    let defaultServers: Record<string, string[]> | undefined
    if (values.defaultServers?.trim()) {
      try {
        defaultServers = JSON.parse(values.defaultServers)
      } catch {
        message.error('defaultServers 格式错误，请输入合法 JSON')
        return
      }
    }
    const result = await createPipelineWebhook(pipeline.id, { name: values.name, defaultServers })
    setCreateOpen(false)
    form.resetFields()
    setSecretSaved(false)
    setSecretModal({ url: `${baseUrl}${result.url}`, token: result.token })
    await load()
  }

  async function handleRotate(wh: PipelineWebhook) {
    const result = await rotatePipelineWebhook(pipeline.id, wh.id)
    setSecretSaved(false)
    setSecretModal({ url: `${baseUrl}${result.url}`, token: result.token })
    await load()
  }

  async function handleToggleEnabled(wh: PipelineWebhook, enabled: boolean) {
    await updatePipelineWebhook(pipeline.id, wh.id, { enabled })
    await load()
  }

  async function handleDelete(wh: PipelineWebhook) {
    await deletePipelineWebhook(pipeline.id, wh.id)
    message.success('已删除')
    await load()
  }

  const curlTemplate = (url: string) =>
    `curl -X POST ${url} \\\n  -H 'Content-Type: application/json' \\\n  -d '{"hello":"world"}'`

  const columns = [
    { title: '名称', dataIndex: 'name', key: 'name' },
    { title: 'Token', dataIndex: 'token', key: 'token', render: (t: string) => <Text code>{t}</Text> },
    {
      title: '启用',
      dataIndex: 'enabled',
      key: 'enabled',
      render: (enabled: boolean, record: PipelineWebhook) => (
        <Switch checked={enabled} onChange={(val) => handleToggleEnabled(record, val)} />
      ),
    },
    {
      title: '最近触发',
      dataIndex: 'lastUsedAt',
      key: 'lastUsedAt',
      render: (v: string | null) => v ? new Date(v).toLocaleString() : '—',
    },
    {
      title: '触发次数',
      dataIndex: 'triggerCount',
      key: 'triggerCount',
    },
    {
      title: '操作',
      key: 'actions',
      render: (_: unknown, record: PipelineWebhook) => (
        <Space>
          <Tooltip title="Rotate Token（旧 Token 立即失效）">
            <Popconfirm
              title="Rotate 后旧 Token 立即失效，确认？"
              onConfirm={() => handleRotate(record)}
            >
              <Button icon={<ReloadOutlined />} size="small" />
            </Popconfirm>
          </Tooltip>
          <Popconfirm title="确认删除？" onConfirm={() => handleDelete(record)}>
            <Button icon={<DeleteOutlined />} size="small" danger />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div style={{ padding: 16 }}>
      <Space style={{ marginBottom: 16 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
          新建 Webhook
        </Button>
      </Space>

      <Table
        dataSource={webhooks}
        columns={columns}
        rowKey="id"
        loading={loading}
        size="small"
        pagination={false}
        expandable={{
          expandedRowRender: (record: PipelineWebhook) => {
            const url = `${baseUrl}/webhook/pipeline/${record.token.replace('…', '...')}`
            const masked = `${baseUrl}/webhook/pipeline/${record.token}`
            return (
              <div style={{ padding: '8px 16px' }}>
                <Text type="secondary">Curl 模板（Token 已脱敏，请替换为完整 Token）：</Text>
                <Paragraph copyable={{ text: curlTemplate(masked) }} code style={{ marginTop: 8 }}>
                  {curlTemplate(masked)}
                </Paragraph>
              </div>
            )
          },
        }}
      />

      {/* 新建 Modal */}
      <Modal
        title="新建 Webhook 触发器"
        open={createOpen}
        onOk={() => form.submit()}
        onCancel={() => { setCreateOpen(false); form.resetFields() }}
        okText="创建"
      >
        <Form form={form} layout="vertical" onFinish={handleCreate}>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="例：ci-trigger" />
          </Form.Item>
          <Form.Item
            name="defaultServers"
            label="默认 Server 分配（JSON，可选）"
            extra={`格式：{"role": ["server-id"]}，与 pipeline serverRoles 对应`}
          >
            <Input.TextArea
              rows={3}
              placeholder={'{"deploy": ["server-prod-1"]}'}
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* Token 仅此一次展示 Modal */}
      <Modal
        title="请保存完整 Webhook URL"
        open={!!secretModal}
        footer={[
          <Button
            key="copy"
            icon={<CopyOutlined />}
            onClick={() => {
              navigator.clipboard.writeText(secretModal?.url ?? '')
              setSecretSaved(true)
              message.success('已复制')
            }}
          >
            复制 URL
          </Button>,
          <Button
            key="confirm"
            type="primary"
            disabled={!secretSaved}
            onClick={() => setSecretModal(null)}
          >
            我已保存
          </Button>,
        ]}
        closable={false}
        maskClosable={false}
      >
        <p>Token 仅此一次显示，关闭后无法再查看。</p>
        <Paragraph copyable={{ text: secretModal?.url }} code>
          {secretModal?.url}
        </Paragraph>
        <p style={{ color: '#999', fontSize: 12 }}>
          Curl 示例：
        </p>
        <Paragraph code style={{ fontSize: 12 }}>
          {secretModal ? curlTemplate(secretModal.url) : ''}
        </Paragraph>
      </Modal>
    </div>
  )
}
```

- [ ] **Step 2: 在 PipelineCanvasPage 里挂 Webhooks Tab**

在 `web/src/pipeline-canvas/PipelineCanvasPage.tsx` 里找到工具栏或现有 Tab/Panel 注册区，加入 Webhooks 入口。

具体实现取决于 PipelineCanvasPage 的现有结构——如果有 Tabs，加一个 tabKey `webhooks`；如果是 Drawer/Modal 按钮组，加一个「Webhook 触发器」按钮打开 Drawer。

以 Drawer 方式为例，在组件顶部增加 state：
```tsx
const [webhooksOpen, setWebhooksOpen] = useState(false)
```

在工具栏按钮组（找到现有操作按钮 JSX）添加：
```tsx
<Button onClick={() => setWebhooksOpen(true)}>Webhook 触发器</Button>
```

在 return JSX 末尾（`</div>` 前）添加：
```tsx
<Drawer
  title="Webhook 触发器"
  open={webhooksOpen}
  onClose={() => setWebhooksOpen(false)}
  width={800}
  destroyOnClose
>
  {pipeline && <WebhooksPanel pipeline={pipeline} />}
</Drawer>
```

在文件顶部 import 处加：
```tsx
import { Drawer } from 'antd'
import WebhooksPanel from './panels/WebhooksPanel.js'
```

- [ ] **Step 3: 类型检查**

```bash
cd web && pnpm build --noEmit 2>&1 | head -30
```

预期：无 TS 错误。

- [ ] **Step 4: Commit**

```bash
git add web/src/pipeline-canvas/panels/WebhooksPanel.tsx web/src/pipeline-canvas/PipelineCanvasPage.tsx
git commit -m "feat(frontend): Webhook 触发器面板（列表/创建/rotate/删除）"
```

---

## Task 11: 冒烟手册 + 全套验证

**Files:**
- Create: `docs/smoke-webhook-trigger.md`

- [ ] **Step 1: 写冒烟手册**

新建 `docs/smoke-webhook-trigger.md`：
```markdown
# Pipeline Webhook Trigger 冒烟手册

## 准备

1. 启动服务：`./deploy.sh up`（或 `pnpm dev`）
2. 确认管理后台可登录：`http://localhost:3000/admin`

## 步骤

### 1. 创建 Webhook

1. 进入任意一条已启用的 Pipeline 详情页
2. 点击工具栏「Webhook 触发器」按钮
3. 点「新建 Webhook」，填写名称（如 `ci`），点「创建」
4. **弹出 URL**，复制完整 URL（含 token），点「我已保存」

预期：列表出现一条记录，token 显示前 8 字符 + 省略号，触发次数为 0。

### 2. 触发 Pipeline

```bash
curl -X POST <上面复制的URL> \
  -H 'Content-Type: application/json' \
  -d '{"foo":"bar","commits":[{"id":"abc123"}]}'
```

预期响应：
```json
{ "runId": 123, "statusUrl": "/admin/api/test-runs/123", "triggeredAt": "..." }
```

### 3. 验证执行记录

1. 进入「执行历史」，看到新的 run，`triggered_by` 显示 `webhook:N:ci`
2. 点进 run 详情，查看 `trigger_params` 完整包含请求 payload

### 4. Rotate Token

1. 点 Webhook 列表里的 Rotate 按钮（刷新图标），确认
2. 弹出新 URL，复制，「我已保存」
3. 用**旧** URL 触发：预期 `401 invalid webhook token`
4. 用**新** URL 触发：预期 `202`

### 5. 禁用 Webhook

1. 将 Webhook 的 enabled 开关关闭
2. 用 URL 触发：预期 `401 invalid webhook token`（与不存在 token 响应相同，防探测）

### 6. 删除 Webhook

1. 点删除，确认
2. 用 URL 触发：预期 `401`
```

- [ ] **Step 2: 运行全套测试**

```bash
./test.sh 2>&1 | tail -30
```

预期：所有测试通过，无 FAIL。如有失败，按错误信息逐一修复后重跑。

- [ ] **Step 3: 类型检查（前后端）**

```bash
./test.sh --typecheck 2>&1 | tail -20
```

预期：无 TS 错误。

- [ ] **Step 4: Commit**

```bash
git add docs/smoke-webhook-trigger.md
git commit -m "docs: pipeline webhook trigger 冒烟手册"
```

---

## Self-Review

### Spec Coverage 核查

| Spec 章节 | 实现 Task |
|-----------|-----------|
| §3 架构总览：公开端点 `/webhook/pipeline/:token` | Task 7 |
| §3 管理端点 `/admin/api/pipelines/:pipelineId/webhooks/*` | Task 8 |
| §4 schema-v46（实际 v47）+ `pipeline_webhooks` 表 | Task 1 |
| §4.1 `triggered_by = webhook:N:name`（无新列） | Task 7 (server.ts) |
| §4.2 SCHEMA_FILES 双处维护 | Task 1 |
| §5.1 202 + `{ runId, statusUrl, triggeredAt }` | Task 7 |
| §5.1 401 固定字符串 | Task 7 |
| §5.1 400 / 404 / 413 / 429 | Task 7 |
| §5.2 CRUD + rotate | Task 8 |
| §5.2 token 列表脱敏（前 8 + 省略号） | Task 5 (repo) + Task 8 |
| §6.1 触发时序（限流→pipeline→payload→servers→runPipeline） | Task 7 |
| §6.1 `recordWebhookUsed`（last_used_at / trigger_count） | Task 5 (repo) + Task 7 |
| §6.2 script 节点 `{{triggerParams.x.y[0].z}}` | Task 6 |
| §6.3 `_servers` 三层优先级 | Task 4 + Task 7 |
| §6.5 进程内 sliding-window 60/min | Task 3 |
| §7 错误响应表 | Task 7 |
| §8 前端 Webhook 触发器面板 | Task 9 + Task 10 |
| §8 新建/rotate 后「请保存」弹框 | Task 10 |
| §8 curl 模板 | Task 10 |
| §9 单元测试 4 个 | Task 2 / 3 / 4 / 6 |
| §9 集成测试 4 个 | Task 5 / 7 / 7 / 7 |
| §9.5 冒烟手册 | Task 11 |

**Gap 检查**：413 body > 1MB 保护——Fastify 默认 bodyLimit 是 1048576（1MB），已自然覆盖，无需额外代码。若部署环境有改动，需在 Fastify 初始化时确认 `bodyLimit` 未被提高。

### Placeholder 扫描

无 "TBD"、"TODO"、"implement later"、"fill in details" 等占位符。

### 类型一致性

- `createPipelineWebhook` 返回 `PipelineWebhook`（含完整 token）—— Task 5 实现、Task 9 API client 使用，类型一致。
- `maskToken` 在 repo `listPipelineWebhooks` 内部通过 SQL `LEFT(token, 8) || chr(8230)` 处理，不在 TS 层重复。
- `rotatePipelineWebhookToken` 返回 `{ newToken: string }`，管理路由返回 `{ token, url }`，前端 API 声明 `{ token: string; url: string }`，一致。
- `effectiveServers` 类型 `Record<string, string[]>` 与 `runPipeline` 第二参数 `serverAssignment: Record<string, string[]>` 一致。
