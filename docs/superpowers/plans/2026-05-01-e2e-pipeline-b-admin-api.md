# E2E Pipeline B — Admin API (e2e-runs) 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 e2e-runs 的 REST CRUD + abort API，供前端和 IM 之外的触发路径使用。

**Architecture:** Fastify 插件风格；POST /e2e-runs fire & forget（不 await runPipelineB）立刻返回 202；abort 先改 DB 状态再 best-effort 清理沙盒和分支。

**Tech Stack:** TypeScript, Fastify 5, PostgreSQL, Vitest + testcontainer pg

**前置条件:** Plan B5（runPipelineB runner）完成

---

## 文件地图

| 操作 | 路径 |
|---|---|
| 修改 | `src/db/repositories/e2e-runs.ts` |
| 新建 | `src/admin/routes/e2e-runs.ts` |
| 修改 | `src/admin/index.ts` |
| 新建 | `src/__tests__/integration/e2e-runs-api.test.ts` |

---

### Task 1: 扩展 e2e-runs repository（listE2eRuns + countQueuedE2eRuns）

**Files:**
- 修改: `src/db/repositories/e2e-runs.ts`

- [ ] **Step 1: 在 e2e-runs.ts 末尾追加两个函数**

在现有的 `listInflightE2eRuns` 之后追加：

```typescript
export async function listE2eRuns(
  filter: { projectId?: string; limit?: number; offset?: number },
): Promise<{ runs: E2eRun[]; total: number }> {
  const limit = Math.min(filter.limit ?? 20, 100)
  const offset = filter.offset ?? 0
  const conditions: string[] = []
  const params: unknown[] = []

  if (filter.projectId) {
    params.push(filter.projectId)
    conditions.push(`target_project_id = $${params.length}`)
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  params.push(limit)
  params.push(offset)

  const { rows } = await getPool().query(
    `SELECT *, COUNT(*) OVER() AS _total
     FROM e2e_runs ${where}
     ORDER BY started_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  )

  const total = rows.length > 0 ? Number(rows[0]._total) : 0
  return { runs: rows.map(mapRow), total }
}

export async function countQueuedE2eRuns(): Promise<number> {
  const { rows } = await getPool().query(
    `SELECT COUNT(*) AS n FROM e2e_runs WHERE status IN ('pending', 'running', 'awaiting_fix')`,
  )
  return Number(rows[0].n)
}
```

注意：`mapRow` 里不需要处理 `_total` 字段——`rows[0]._total` 在 `mapRow` 调用前单独读出，`mapRow` 只映射已知列，pg 驱动会把多余列安静地保留在 `r` 对象里但不被 `as` 读取，不会导致类型错误。

---

### Task 2: e2e-runs.ts 路由实现

**Files:**
- 新建: `src/admin/routes/e2e-runs.ts`

- [ ] **Step 1: 创建路由文件**

```typescript
// src/admin/routes/e2e-runs.ts
import type { FastifyInstance } from 'fastify'
import {
  getE2eRun,
  updateE2eRunStatus,
  listE2eRuns,
} from '../../db/repositories/e2e-runs.js'
import { listScenarioRuns } from '../../db/repositories/e2e-scenario-runs.js'
import { getSandboxByRunId } from '../../db/repositories/e2e-sandboxes.js'
import { runPipelineB } from '../../e2e/pipeline-b/runner.js'

function serializeRun(run: { id: bigint; [k: string]: unknown }): Record<string, unknown> {
  return { ...run, id: run.id.toString() }
}

function serializeScenarioRun(sr: { id: bigint; e2eRunId: bigint; linkedBugReportId: bigint | null; [k: string]: unknown }): Record<string, unknown> {
  return {
    ...sr,
    id: sr.id.toString(),
    e2eRunId: sr.e2eRunId.toString(),
    linkedBugReportId: sr.linkedBugReportId?.toString() ?? null,
  }
}

function serializeSandbox(sb: { id: bigint; e2eRunId: bigint | null; [k: string]: unknown } | null): Record<string, unknown> | null {
  if (!sb) return null
  return {
    ...sb,
    id: sb.id.toString(),
    e2eRunId: sb.e2eRunId?.toString() ?? null,
  }
}

export async function registerE2eRunRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { projectId?: string; limit?: string; offset?: string } }>(
    '/e2e-runs',
    async (req, reply) => {
      const { projectId, limit, offset } = req.query
      const result = await listE2eRuns({
        projectId,
        limit: limit ? parseInt(limit, 10) : undefined,
        offset: offset ? parseInt(offset, 10) : undefined,
      })
      return reply.send({
        runs: result.runs.map(serializeRun),
        total: result.total,
      })
    },
  )

  app.get<{ Params: { runId: string } }>('/e2e-runs/:runId', async (req, reply) => {
    const run = await getE2eRun(BigInt(req.params.runId))
    if (!run) return reply.status(404).send({ error: 'run not found' })
    const [sandbox, scenarioRuns] = await Promise.all([
      getSandboxByRunId(run.id),
      listScenarioRuns(run.id),
    ])
    return reply.send({
      run: serializeRun(run),
      sandbox: serializeSandbox(sandbox),
      scenarioRuns: scenarioRuns.map(serializeScenarioRun),
    })
  })

  app.post<{
    Body: {
      targetProjectId: string
      sourceBranch?: string
      scenarioFilter?: { ids?: string[]; tags?: string[] }
      governorOverrides?: { maxPerScenarioAttempts?: number; maxRunHours?: number; maxTotalAttempts?: number }
    }
  }>('/e2e-runs', async (req, reply) => {
    const { targetProjectId, sourceBranch, scenarioFilter, governorOverrides } = req.body
    if (!targetProjectId) {
      return reply.status(400).send({ error: 'targetProjectId required' })
    }

    const { runId, status } = await runPipelineB({
      targetProjectId,
      sourceBranch: sourceBranch ?? 'main',
      scenarioFilter,
      triggerType: 'api',
      governorOverrides,
    })

    return reply.status(202).send({ runId: runId.toString(), status })
  })

  app.post<{ Params: { runId: string }; Body: { reason?: string } }>(
    '/e2e-runs/:runId/abort',
    async (req, reply) => {
      const run = await getE2eRun(BigInt(req.params.runId))
      if (!run) return reply.status(404).send({ error: 'run not found' })

      const abortReason = req.body.reason ?? 'user_abort'
      await updateE2eRunStatus(run.id, 'aborted', {
        finishedAt: new Date(),
        abortReason,
      })

      const sandbox = await getSandboxByRunId(run.id)
      if (sandbox) {
        import('../../e2e/pipeline-b/sandbox.js').then(({ teardownSandboxBestEffort }) => {
          teardownSandboxBestEffort(sandbox).catch((err: unknown) => {
            console.error('[e2e-runs:abort] sandbox teardown error:', err)
          })
        }).catch(() => {})
      }
      if (run.iterationBranch) {
        import('../../e2e/pipeline-b/git-ops.js').then(({ deleteRemoteBranchBestEffort }) => {
          deleteRemoteBranchBestEffort(run.iterationBranch).catch((err: unknown) => {
            console.error('[e2e-runs:abort] branch delete error:', err)
          })
        }).catch(() => {})
      }

      return reply.send({ ok: true })
    },
  )
}
```

**注意（关于 abort 中的动态 import）：**

`teardownSandboxBestEffort` 和 `deleteRemoteBranchBestEffort` 由 Plan B5 实现，路径
`src/e2e/pipeline-b/sandbox.ts` 和 `src/e2e/pipeline-b/git-ops.ts`。如果 Plan B5 将
这两个函数放在不同文件，请在实现时对应调整 import 路径。若这两个函数尚未实现（Plan B5
未完成），可暂时用日志占位：

```typescript
// 临时占位，等 Plan B5 实现后替换
console.warn('[e2e-runs:abort] teardown/branch-delete not yet implemented')
```

---

### Task 3: admin/index.ts 注册 + 集成测试

**Files:**
- 修改: `src/admin/index.ts`
- 新建: `src/__tests__/integration/e2e-runs-api.test.ts`

- [ ] **Step 1: 在 admin/index.ts 中注册新路由**

在现有的两行 e2e import 之后添加：

```typescript
import { registerE2eRunRoutes } from './routes/e2e-runs.js'
```

在 `registerE2eSpecRoutes(app)` 之后添加：

```typescript
await registerE2eRunRoutes(app)
```

完整修改点（两处，保持现有顺序不变）：

```typescript
// import 区域（紧接 e2e-specs 那行之后）：
import { registerE2eTargetRoutes } from './routes/e2e-targets.js'
import { registerE2eSpecRoutes } from './routes/e2e-specs.js'
import { registerE2eRunRoutes } from './routes/e2e-runs.js'   // <-- 新增

// 注册区域（紧接 registerE2eSpecRoutes 那行之后）：
await registerE2eTargetRoutes(app)
await registerE2eSpecRoutes(app)
await registerE2eRunRoutes(app)   // <-- 新增
```

- [ ] **Step 2: 集成测试**

```typescript
// src/__tests__/integration/e2e-runs-api.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { resetTestDb } from '../helpers/db.js'
import { buildAdminTestApp } from '../helpers/admin-app.js'
import { registerE2eRunRoutes } from '../../admin/routes/e2e-runs.js'
import { createE2eRun, getE2eRun } from '../../db/repositories/e2e-runs.js'
import type { FastifyInstance } from 'fastify'

vi.mock('../../e2e/pipeline-b/runner.js', () => ({
  runPipelineB: vi.fn().mockResolvedValue({ runId: 1n, status: 'pending' }),
}))

async function buildApp(): Promise<FastifyInstance> {
  return buildAdminTestApp(async (app) => {
    await registerE2eRunRoutes(app)
  })
}

beforeEach(async () => {
  await resetTestDb()
  vi.clearAllMocks()
})

describe('GET /e2e-runs', () => {
  it('returns empty list when no runs', async () => {
    const app = await buildApp()
    const r = await app.inject({ method: 'GET', url: '/e2e-runs' })
    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(body.runs).toEqual([])
    expect(body.total).toBe(0)
    await app.close()
  })

  it('returns runs with total count', async () => {
    await createE2eRun({ targetProjectId: 'chatops', triggerType: 'manual', triggerActor: 'alice', sourceBranch: 'main', iterationBranch: 'e2e/iter-1', scenarioFilter: null })
    await createE2eRun({ targetProjectId: 'chatops', triggerType: 'api', triggerActor: null, sourceBranch: 'main', iterationBranch: 'e2e/iter-2', scenarioFilter: null })
    const app = await buildApp()
    const r = await app.inject({ method: 'GET', url: '/e2e-runs' })
    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(body.runs).toHaveLength(2)
    expect(body.total).toBe(2)
    expect(typeof body.runs[0].id).toBe('string')
    await app.close()
  })

  it('filters by projectId', async () => {
    await createE2eRun({ targetProjectId: 'chatops', triggerType: 'manual', triggerActor: null, sourceBranch: 'main', iterationBranch: 'e2e/iter-1', scenarioFilter: null })
    await createE2eRun({ targetProjectId: 'other-project', triggerType: 'manual', triggerActor: null, sourceBranch: 'main', iterationBranch: 'e2e/iter-2', scenarioFilter: null })
    const app = await buildApp()
    const r = await app.inject({ method: 'GET', url: '/e2e-runs?projectId=chatops' })
    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(body.runs).toHaveLength(1)
    expect(body.total).toBe(1)
    expect(body.runs[0].targetProjectId).toBe('chatops')
    await app.close()
  })

  it('respects limit and offset', async () => {
    for (let i = 0; i < 5; i++) {
      await createE2eRun({ targetProjectId: 'chatops', triggerType: 'manual', triggerActor: null, sourceBranch: 'main', iterationBranch: `e2e/iter-${i}`, scenarioFilter: null })
    }
    const app = await buildApp()
    const r = await app.inject({ method: 'GET', url: '/e2e-runs?limit=2&offset=2' })
    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(body.runs).toHaveLength(2)
    expect(body.total).toBe(5)
    await app.close()
  })
})

describe('GET /e2e-runs/:runId', () => {
  it('returns 404 for unknown id', async () => {
    const app = await buildApp()
    const r = await app.inject({ method: 'GET', url: '/e2e-runs/99999' })
    expect(r.statusCode).toBe(404)
    await app.close()
  })

  it('returns run with sandbox and scenarioRuns', async () => {
    const run = await createE2eRun({ targetProjectId: 'chatops', triggerType: 'manual', triggerActor: 'bob', sourceBranch: 'main', iterationBranch: 'e2e/iter-1', scenarioFilter: null })
    const app = await buildApp()
    const r = await app.inject({ method: 'GET', url: `/e2e-runs/${run.id.toString()}` })
    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(body.run.id).toBe(run.id.toString())
    expect(body.run.targetProjectId).toBe('chatops')
    expect(body.sandbox).toBeNull()
    expect(body.scenarioRuns).toEqual([])
    await app.close()
  })
})

describe('POST /e2e-runs', () => {
  it('returns 400 when targetProjectId missing', async () => {
    const app = await buildApp()
    const r = await app.inject({
      method: 'POST',
      url: '/e2e-runs',
      payload: {},
    })
    expect(r.statusCode).toBe(400)
    await app.close()
  })

  it('returns 202 and fires runPipelineB without awaiting', async () => {
    const { runPipelineB } = await import('../../e2e/pipeline-b/runner.js')
    const app = await buildApp()
    const r = await app.inject({
      method: 'POST',
      url: '/e2e-runs',
      payload: { targetProjectId: 'chatops', sourceBranch: 'feature/x' },
    })
    expect(r.statusCode).toBe(202)
    const body = r.json()
    expect(body.runId).toBe('1')
    expect(body.status).toBe('pending')
    expect(runPipelineB).toHaveBeenCalledWith(expect.objectContaining({
      targetProjectId: 'chatops',
      sourceBranch: 'feature/x',
      triggerType: 'api',
    }))
    await app.close()
  })

  it('defaults sourceBranch to main', async () => {
    const { runPipelineB } = await import('../../e2e/pipeline-b/runner.js')
    const app = await buildApp()
    await app.inject({
      method: 'POST',
      url: '/e2e-runs',
      payload: { targetProjectId: 'chatops' },
    })
    expect(runPipelineB).toHaveBeenCalledWith(expect.objectContaining({ sourceBranch: 'main' }))
    await app.close()
  })
})

describe('POST /e2e-runs/:runId/abort', () => {
  it('returns 404 for unknown runId', async () => {
    const app = await buildApp()
    const r = await app.inject({
      method: 'POST',
      url: '/e2e-runs/99999/abort',
      payload: {},
    })
    expect(r.statusCode).toBe(404)
    await app.close()
  })

  it('updates run status to aborted with default reason', async () => {
    const run = await createE2eRun({ targetProjectId: 'chatops', triggerType: 'manual', triggerActor: null, sourceBranch: 'main', iterationBranch: 'e2e/iter-1', scenarioFilter: null })
    const app = await buildApp()
    const r = await app.inject({
      method: 'POST',
      url: `/e2e-runs/${run.id.toString()}/abort`,
      payload: {},
    })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ ok: true })
    const updated = await getE2eRun(run.id)
    expect(updated?.status).toBe('aborted')
    expect(updated?.abortReason).toBe('user_abort')
    expect(updated?.finishedAt).not.toBeNull()
    await app.close()
  })

  it('uses custom abort reason when provided', async () => {
    const run = await createE2eRun({ targetProjectId: 'chatops', triggerType: 'manual', triggerActor: null, sourceBranch: 'main', iterationBranch: 'e2e/iter-2', scenarioFilter: null })
    const app = await buildApp()
    await app.inject({
      method: 'POST',
      url: `/e2e-runs/${run.id.toString()}/abort`,
      payload: { reason: 'timeout_exceeded' },
    })
    const updated = await getE2eRun(run.id)
    expect(updated?.abortReason).toBe('timeout_exceeded')
    await app.close()
  })
})
```

**测试命令：**
```bash
npx vitest run src/__tests__/integration/e2e-runs-api.test.ts
```

---

## 实现注意事项

**bigint 序列化：** `id`、`e2eRunId`、`linkedBugReportId` 均为 PostgreSQL `bigint`，在 JSON 中必须用 `.toString()` 转 string，否则 `JSON.stringify` 会抛 `TypeError: Do not know how to serialize a BigInt`。路由里的 `serializeRun` / `serializeScenarioRun` / `serializeSandbox` 三个辅助函数统一处理。

**fire & forget 语义：** `POST /e2e-runs` 调用 `runPipelineB` 时不能 `await`。因为 `runPipelineB` 本身会在内部创建 DB 记录并返回 `{ runId, status }`，所以需要先 `await runPipelineB(...)` 拿到 runId 后再立刻回 202——这是"拿到 run 元数据"而不是"等图跑完"。`runPipelineB` 应当在内部启动图之后即返回，图的执行是异步的。

**abort best-effort 的动态 import：** abort 路由用动态 `import()` 加载 teardown 函数，目的是避免在 Plan B5 完成之前就静态依赖不存在的模块导致启动失败。等 Plan B5 完成后可改为静态 import。

**`_total` 字段污染问题：** `listE2eRuns` 的 SQL 用了 `COUNT(*) OVER()` 窗口函数，返回的每行都带 `_total` 字段。`mapRow` 函数只做显式字段映射（逐字段 `as`），不会受多余字段影响；`_total` 在 `mapRow` 调用前从 `rows[0]._total` 单独读出。
