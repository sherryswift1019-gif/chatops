# Pipeline 触发参数统一采集 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除 `im_input` 节点类型，将 paramSchema 提升到 pipeline 定义层，四种触发方式（IM/Webhook/Schedule/Manual）各自在 runPipeline 前完成参数采集/校验。

**Architecture:** 新建 `im-param-collector.ts` 处理 IM 多轮采集（waiter 模式，调 runPipeline 前完成）；`validate-trigger-params.ts` 做通用 schema 校验；新建 `scheduler.ts` + `pipeline_schedules` 表处理定时触发；前端 PipelineSettingsPanel 新增触发参数 Tab 和 Schedule Tab。

**Tech Stack:** Node.js/TypeScript, Fastify 5, PostgreSQL (pg), Vitest, React 18 + Ant Design 5, node-cron

---

## File Map

**新建（后端）**
- `src/db/schema-v53.sql` — DDL: `test_pipelines` 新增列 + `pipeline_schedules` 表
- `src/pipeline/validate-trigger-params.ts` — paramSchema 校验工具函数
- `src/pipeline/im-param-collector.ts` — IM 多轮采集逻辑
- `src/pipeline/scheduler.ts` — node-cron pipeline 定时调度器
- `src/db/repositories/pipeline-schedules.ts` — pipeline_schedules CRUD
- `src/admin/routes/pipeline-schedules.ts` — schedule CRUD admin 路由

**新建（测试）**
- `src/__tests__/unit/pipeline/validate-trigger-params.test.ts`
- `src/__tests__/unit/pipeline/im-param-collector.test.ts`
- `src/__tests__/unit/pipeline/scheduler.test.ts`

**修改（后端）**
- `src/db/migrate.ts` — 追加 v53
- `src/__tests__/helpers/db.ts` — 追加 v53
- `src/db/repositories/test-pipelines.ts` — 新增 paramSchema / imPrompt 字段
- `src/pipeline/im-router.ts` — 新增 ParamCollectWaiter
- `src/agent/session-manager.ts` — 路由优先查 ParamCollectWaiter
- `src/agent/coordinator.ts` — IM pipeline 触发前调 im-param-collector
- `src/pipeline/executor.ts` — runPipeline 入口加 validateTriggerParams
- `src/pipeline/webhook-router.ts` — payload 校验 400
- `src/admin/index.ts` — 注册 schedule 路由
- `src/server.ts` — 启动 scheduler

**修改（删除 im_input）**
- `src/pipeline/graph-builder.ts` — 删除 buildImInputNode / buildImInputDryRunNode / case 'im_input'
- `src/pipeline/graph-runner.ts` — 删除 IM_INPUT_INTERRUPT 分支
- `src/pipeline/types.ts` — 删除 ImInputConfig / 'im_input'
- `src/agent/session-manager.ts` — 删除 findImInputWaiter / resumeFromImInput 引用

**修改（前端）**
- `web/src/types/index.ts` — TestPipeline 新增 paramSchema/imPrompt
- `web/src/pipeline-canvas/types.ts` — 删 'im_input' / ImInputConfig
- `web/src/pipeline-canvas/PipelineCanvasPage.tsx` — 删 im_input 创建逻辑
- `web/src/pipeline-canvas/panels/NodeInspector.tsx` — 删 im_input 面板
- `web/src/pipeline-canvas/graph-validation.ts` — 删 im_input 校验
- `web/src/pipeline-canvas/panels/pruneStageFields.ts` — 删 im_input case
- `web/src/pipeline-canvas/panels/PipelineSettingsPanel.tsx` — 新增「触发参数」Tab 和「定时规则」Tab

**新建（前端）**
- `web/src/pipeline-canvas/panels/TriggerParamsPanel.tsx` — paramSchema 编辑 + imPrompt
- `web/src/pipeline-canvas/panels/SchedulesPanel.tsx` — pipeline_schedules 管理
- `web/src/pipeline-canvas/panels/ParamSchemaForm.tsx` — 根据 schema 动态渲染 Ant Design Form（手动触发/预设参数复用）

---

### Task 1: DB migration v53

**Files:**
- Create: `src/db/schema-v53.sql`
- Modify: `src/db/migrate.ts`
- Modify: `src/__tests__/helpers/db.ts`

- [ ] **Step 1: 创建 schema-v53.sql**

```sql
-- v53: pipeline 触发参数 schema 提升 + pipeline_schedules 定时规则表

ALTER TABLE test_pipelines
  ADD COLUMN IF NOT EXISTS param_schema JSONB DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS im_prompt    TEXT  DEFAULT NULL;

CREATE TABLE IF NOT EXISTS pipeline_schedules (
  id            SERIAL PRIMARY KEY,
  pipeline_id   INT  NOT NULL REFERENCES test_pipelines(id) ON DELETE CASCADE,
  name          TEXT NOT NULL DEFAULT '',
  cron_expr     TEXT NOT NULL,
  preset_params JSONB NOT NULL DEFAULT '{}',
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pipeline_schedules_pipeline_id
  ON pipeline_schedules(pipeline_id);
```

- [ ] **Step 2: 追加到 migrate.ts SCHEMA_FILES**

在 `src/db/migrate.ts` 找到 `['v52', 'schema-v52.sql'],`，在其后追加：

```typescript
  ['v53', 'schema-v53.sql'],
```

- [ ] **Step 3: 追加到测试 db helper**

在 `src/__tests__/helpers/db.ts` 找到 `'schema-v51.sql',`（最后一项），在其后追加：

```typescript
  // v53: test_pipelines 新增 param_schema/im_prompt 列 + pipeline_schedules 纯 DDL，安全加入。
  'schema-v53.sql',
```

- [ ] **Step 4: 验证迁移可跑**

```bash
pnpm migrate
```

Expected：输出 `Applied v53` 且无错误。

- [ ] **Step 5: Commit**

```bash
git add src/db/schema-v53.sql src/db/migrate.ts src/__tests__/helpers/db.ts
git commit -m "feat: schema-v53 add param_schema/im_prompt + pipeline_schedules"
```

---

### Task 2: test-pipelines repository — 新增 paramSchema / imPrompt

**Files:**
- Modify: `src/db/repositories/test-pipelines.ts`
- Test: `src/__tests__/unit/db/test-pipelines-repo.test.ts`（若已存在则在其中新增用例）

- [ ] **Step 1: 在 TestPipeline 接口新增字段**

在 `src/db/repositories/test-pipelines.ts` 的 `TestPipeline` interface 中：

```typescript
export interface TestPipeline {
  id: number
  productLineId: number
  name: string
  description: string
  stages: unknown[]
  serverRoles: Record<string, { count: number }>
  enabled: boolean
  triggerParams: Record<string, unknown>
  variables: Record<string, string>
  artifactInputs: unknown[]
  graph: unknown | null
  containerImage: string | null
  paramSchema: Record<string, unknown> | null   // 新增
  imPrompt: string | null                        // 新增
  createdAt: Date
  updatedAt: Date
}
```

- [ ] **Step 2: 更新 mapRow**

```typescript
function mapRow(r: Record<string, unknown>): TestPipeline {
  return {
    id: r.id as number, productLineId: (r.product_line_id ?? 0) as number,
    name: r.name as string, description: (r.description ?? '') as string,
    stages: (r.stages ?? []) as unknown[], serverRoles: (r.server_roles ?? {}) as Record<string, { count: number }>,
    enabled: r.enabled as boolean,
    triggerParams: (r.trigger_params ?? {}) as Record<string, unknown>,
    variables: (r.variables ?? {}) as Record<string, string>,
    artifactInputs: (r.artifact_inputs ?? []) as unknown[],
    graph: (r.graph ?? null) as unknown,
    containerImage: (r.container_image ?? null) as string | null,
    paramSchema: (r.param_schema ?? null) as Record<string, unknown> | null,  // 新增
    imPrompt: (r.im_prompt ?? null) as string | null,                          // 新增
    createdAt: r.created_at as Date, updatedAt: r.updated_at as Date,
  }
}
```

- [ ] **Step 3: 更新 updateTestPipeline**

在 `updateTestPipeline` 的 data 参数类型中新增两个可选字段，并在 SQL 里追加：

```typescript
export async function updateTestPipeline(id: number, data: Partial<{
  name: string; description: string; stages: unknown[]
  serverRoles: Record<string, { count: number }>; enabled: boolean
  triggerParams: Record<string, unknown>; variables: Record<string, string>
  artifactInputs: unknown[]
  graph: unknown | null
  containerImage?: string | null
  paramSchema?: Record<string, unknown> | null   // 新增
  imPrompt?: string | null                        // 新增
}>): Promise<TestPipeline | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    `UPDATE test_pipelines SET
       name = COALESCE($2, name), description = COALESCE($3, description),
       stages = COALESCE($4, stages), server_roles = COALESCE($5, server_roles),
       enabled = COALESCE($6, enabled),
       trigger_params = COALESCE($7, trigger_params),
       variables = COALESCE($8, variables),
       artifact_inputs = COALESCE($9, artifact_inputs),
       graph = COALESCE($10, graph),
       container_image = COALESCE($11, container_image),
       param_schema = CASE WHEN $12::boolean THEN $13::jsonb ELSE param_schema END,
       im_prompt    = CASE WHEN $14::boolean THEN $15       ELSE im_prompt    END,
       updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id,
     data.name ?? null, data.description ?? null,
     data.stages ? JSON.stringify(data.stages) : null,
     data.serverRoles ? JSON.stringify(data.serverRoles) : null,
     data.enabled ?? null,
     data.triggerParams ? JSON.stringify(data.triggerParams) : null,
     data.variables ? JSON.stringify(data.variables) : null,
     data.artifactInputs ? JSON.stringify(data.artifactInputs) : null,
     data.graph !== undefined ? (data.graph === null ? null : JSON.stringify(data.graph)) : null,
     data.containerImage ?? null,
     'paramSchema' in data,                                                   // $12: 是否更新
     data.paramSchema !== undefined ? (data.paramSchema === null ? null : JSON.stringify(data.paramSchema)) : null,  // $13
     'imPrompt' in data,                                                      // $14
     data.imPrompt ?? null,                                                   // $15
    ]
  )
  return rows[0] ? mapRow(rows[0]) : null
}
```

- [ ] **Step 4: 运行类型检查**

```bash
./test.sh --typecheck
```

Expected：0 errors

- [ ] **Step 5: Commit**

```bash
git add src/db/repositories/test-pipelines.ts
git commit -m "feat: test-pipelines repo add paramSchema/imPrompt fields"
```

---

### Task 3: pipeline-schedules repository

**Files:**
- Create: `src/db/repositories/pipeline-schedules.ts`

- [ ] **Step 1: 创建 repository**

```typescript
import { getPool } from '../client.js'

export interface PipelineSchedule {
  id: number
  pipelineId: number
  name: string
  cronExpr: string
  presetParams: Record<string, unknown>
  enabled: boolean
  createdAt: Date
  updatedAt: Date
}

function mapRow(r: Record<string, unknown>): PipelineSchedule {
  return {
    id: r.id as number,
    pipelineId: r.pipeline_id as number,
    name: (r.name ?? '') as string,
    cronExpr: r.cron_expr as string,
    presetParams: (r.preset_params ?? {}) as Record<string, unknown>,
    enabled: r.enabled as boolean,
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
  }
}

export async function listPipelineSchedules(pipelineId: number): Promise<PipelineSchedule[]> {
  const pool = getPool()
  const { rows } = await pool.query(
    'SELECT * FROM pipeline_schedules WHERE pipeline_id = $1 ORDER BY id',
    [pipelineId]
  )
  return rows.map(mapRow)
}

export async function listEnabledSchedules(): Promise<PipelineSchedule[]> {
  const pool = getPool()
  const { rows } = await pool.query(
    'SELECT * FROM pipeline_schedules WHERE enabled = true ORDER BY id'
  )
  return rows.map(mapRow)
}

export async function createPipelineSchedule(data: {
  pipelineId: number
  name?: string
  cronExpr: string
  presetParams?: Record<string, unknown>
  enabled?: boolean
}): Promise<PipelineSchedule> {
  const pool = getPool()
  const { rows } = await pool.query(
    `INSERT INTO pipeline_schedules (pipeline_id, name, cron_expr, preset_params, enabled)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [data.pipelineId, data.name ?? '', data.cronExpr,
     JSON.stringify(data.presetParams ?? {}), data.enabled ?? true]
  )
  return mapRow(rows[0])
}

export async function updatePipelineSchedule(id: number, data: Partial<{
  name: string; cronExpr: string; presetParams: Record<string, unknown>; enabled: boolean
}>): Promise<PipelineSchedule | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    `UPDATE pipeline_schedules SET
       name       = COALESCE($2, name),
       cron_expr  = COALESCE($3, cron_expr),
       preset_params = COALESCE($4, preset_params),
       enabled    = COALESCE($5, enabled),
       updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id, data.name ?? null, data.cronExpr ?? null,
     data.presetParams ? JSON.stringify(data.presetParams) : null,
     data.enabled ?? null]
  )
  return rows[0] ? mapRow(rows[0]) : null
}

export async function deletePipelineSchedule(id: number): Promise<boolean> {
  const pool = getPool()
  const { rowCount } = await pool.query('DELETE FROM pipeline_schedules WHERE id = $1', [id])
  return (rowCount ?? 0) > 0
}

export async function getPipelineScheduleById(id: number): Promise<PipelineSchedule | null> {
  const pool = getPool()
  const { rows } = await pool.query('SELECT * FROM pipeline_schedules WHERE id = $1', [id])
  return rows[0] ? mapRow(rows[0]) : null
}
```

- [ ] **Step 2: 运行类型检查**

```bash
./test.sh --typecheck
```

Expected：0 errors

- [ ] **Step 3: Commit**

```bash
git add src/db/repositories/pipeline-schedules.ts
git commit -m "feat: pipeline-schedules repository"
```

---

### Task 4: validateTriggerParams 工具函数（TDD）

**Files:**
- Create: `src/pipeline/validate-trigger-params.ts`
- Create: `src/__tests__/unit/pipeline/validate-trigger-params.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// src/__tests__/unit/pipeline/validate-trigger-params.test.ts
import { describe, it, expect } from 'vitest'
import { validateTriggerParams } from '../../../pipeline/validate-trigger-params.js'

describe('validateTriggerParams', () => {
  it('returns valid=true when paramSchema is null', () => {
    expect(validateTriggerParams(null, {})).toEqual({ valid: true, missingFields: [] })
  })

  it('returns valid=true when all required fields present', () => {
    const schema = { properties: { env: {}, project: {} }, required: ['env', 'project'] }
    expect(validateTriggerParams(schema, { env: 'prod', project: 'foo' }))
      .toEqual({ valid: true, missingFields: [] })
  })

  it('returns missing fields when required field absent', () => {
    const schema = { properties: { env: {}, project: {} }, required: ['env', 'project'] }
    const result = validateTriggerParams(schema, { env: 'prod' })
    expect(result.valid).toBe(false)
    expect(result.missingFields).toEqual(['project'])
  })

  it('treats empty string as missing', () => {
    const schema = { properties: { env: {} }, required: ['env'] }
    const result = validateTriggerParams(schema, { env: '' })
    expect(result.valid).toBe(false)
    expect(result.missingFields).toContain('env')
  })

  it('returns valid=true when no required array in schema', () => {
    const schema = { properties: { env: {} } }
    expect(validateTriggerParams(schema, {})).toEqual({ valid: true, missingFields: [] })
  })
})
```

- [ ] **Step 2: 运行确认失败**

```bash
npx vitest run src/__tests__/unit/pipeline/validate-trigger-params.test.ts
```

Expected：FAIL — `validateTriggerParams` not found

- [ ] **Step 3: 实现**

```typescript
// src/pipeline/validate-trigger-params.ts
export interface ValidateResult {
  valid: boolean
  missingFields: string[]
}

export function validateTriggerParams(
  paramSchema: Record<string, unknown> | null | undefined,
  params: Record<string, unknown>,
): ValidateResult {
  if (!paramSchema) return { valid: true, missingFields: [] }
  const required = (paramSchema.required ?? []) as string[]
  const missingFields = required.filter(k => {
    const v = params[k]
    return v === undefined || v === null || v === ''
  })
  return { valid: missingFields.length === 0, missingFields }
}
```

- [ ] **Step 4: 运行确认通过**

```bash
npx vitest run src/__tests__/unit/pipeline/validate-trigger-params.test.ts
```

Expected：PASS，5 tests

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/validate-trigger-params.ts src/__tests__/unit/pipeline/validate-trigger-params.test.ts
git commit -m "feat: validateTriggerParams utility (TDD)"
```

---

### Task 5: im-router — 新增 ParamCollectWaiter

**Files:**
- Modify: `src/pipeline/im-router.ts`

- [ ] **Step 1: 新增 ParamCollectWaiter 类型和注册表**

在 `src/pipeline/im-router.ts` 末尾追加：

```typescript
// ─── ParamCollectWaiter ──────────────────────────────────────────────────────
// 用于 im-param-collector 在 runPipeline 前采集参数时注册等待点。
// 与 ImWaiter（graph interrupt）平行，各自用独立的 Map。

export interface ParamCollectWaiter {
  platform: string
  groupId: string
  resolve: (message: string) => void
  reject: (err: Error) => void
}

const byGroupCollect = new Map<string, ParamCollectWaiter>()

export function registerParamCollectWaiter(w: ParamCollectWaiter): void {
  byGroupCollect.set(groupKey(w.platform, w.groupId), w)
}

export function unregisterParamCollectWaiter(platform: string, groupId: string): void {
  byGroupCollect.delete(groupKey(platform, groupId))
}

export function findParamCollectWaiter(platform: string, groupId: string): ParamCollectWaiter | null {
  return byGroupCollect.get(groupKey(platform, groupId)) ?? null
}
```

- [ ] **Step 2: 类型检查**

```bash
./test.sh --typecheck
```

Expected：0 errors

- [ ] **Step 3: Commit**

```bash
git add src/pipeline/im-router.ts
git commit -m "feat: im-router add ParamCollectWaiter"
```

---

### Task 6: im-param-collector.ts（TDD）

**Files:**
- Create: `src/pipeline/im-param-collector.ts`
- Create: `src/__tests__/unit/pipeline/im-param-collector.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// src/__tests__/unit/pipeline/im-param-collector.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { findParamCollectWaiter } from '../../../pipeline/im-router.js'

vi.mock('../../../pipeline/im-notifier.js', () => ({
  notifyImGroup: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../pipeline/im-input-agent.js', () => ({
  consultImInputAgent: vi.fn(),
}))

import { collectImParams } from '../../../pipeline/im-param-collector.js'
import { notifyImGroup } from '../../../pipeline/im-notifier.js'
import { consultImInputAgent } from '../../../pipeline/im-input-agent.js'

const schema = {
  properties: { env: { title: '环境', enum: ['dev', 'prod'] } },
  required: ['env'],
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('collectImParams', () => {
  it('单轮即收齐参数', async () => {
    vi.mocked(consultImInputAgent).mockResolvedValueOnce({ done: true, params: { env: 'prod' } })

    const promise = collectImParams('dingtalk', 'g1', schema)

    // waiter 已注册，模拟用户回复
    const waiter = findParamCollectWaiter('dingtalk', 'g1')
    expect(waiter).not.toBeNull()
    waiter!.resolve('env=prod')

    const result = await promise
    expect(result).toEqual({ env: 'prod' })
    expect(notifyImGroup).toHaveBeenCalledOnce()
  })

  it('多轮采集：首次缺字段，第二轮补全', async () => {
    vi.mocked(consultImInputAgent)
      .mockResolvedValueOnce({ done: false, params: {}, nextPrompt: '请提供环境' })
      .mockResolvedValueOnce({ done: true, params: { env: 'dev' } })

    const promise = collectImParams('dingtalk', 'g1', schema)

    // 第一轮
    const w1 = findParamCollectWaiter('dingtalk', 'g1')!
    w1.resolve('hello')

    // 等异步推进到第二轮（需要 microtask flush）
    await new Promise(r => setTimeout(r, 0))

    // 第二轮
    const w2 = findParamCollectWaiter('dingtalk', 'g1')!
    w2.resolve('env=dev')

    const result = await promise
    expect(result).toEqual({ env: 'dev' })
    expect(notifyImGroup).toHaveBeenCalledTimes(2)
  })

  it('用户取消时 reject', async () => {
    vi.mocked(consultImInputAgent).mockResolvedValueOnce({ done: false, aborted: true, params: {} })

    const promise = collectImParams('dingtalk', 'g1', schema)
    const waiter = findParamCollectWaiter('dingtalk', 'g1')!
    waiter.resolve('取消')

    await expect(promise).rejects.toThrow('用户取消')
  })

  it('超时时 reject', async () => {
    vi.useFakeTimers()
    const promise = collectImParams('dingtalk', 'g1', schema)
    // 不 resolve waiter，直接让 timer 到期
    await vi.advanceTimersByTimeAsync(300_001)
    await expect(promise).rejects.toThrow('超时')
    vi.useRealTimers()
  })

  it('使用自定义 imPrompt', async () => {
    vi.mocked(consultImInputAgent).mockResolvedValueOnce({ done: true, params: { env: 'prod' } })
    const promise = collectImParams('dingtalk', 'g1', schema, '请输入部署环境')
    findParamCollectWaiter('dingtalk', 'g1')!.resolve('prod')
    await promise
    expect(notifyImGroup).toHaveBeenCalledWith('dingtalk', 'g1', '请输入部署环境')
  })
})
```

- [ ] **Step 2: 运行确认失败**

```bash
npx vitest run src/__tests__/unit/pipeline/im-param-collector.test.ts
```

Expected：FAIL — `im-param-collector` not found

- [ ] **Step 3: 实现**

```typescript
// src/pipeline/im-param-collector.ts
import { notifyImGroup } from './im-notifier.js'
import {
  registerParamCollectWaiter,
  unregisterParamCollectWaiter,
} from './im-router.js'
import { consultImInputAgent } from './im-input-agent.js'

const COLLECTION_TIMEOUT_MS = 300_000

interface SchemaProperty { type?: string; enum?: string[]; title?: string }

function buildPrompt(paramSchema: Record<string, unknown>, imPrompt?: string | null): string {
  if (imPrompt) return imPrompt
  const props = (paramSchema.properties ?? {}) as Record<string, SchemaProperty>
  const required = (paramSchema.required ?? []) as string[]
  const parts = required.map(k => {
    const p = props[k]
    const label = p?.title ?? k
    const hint = p?.enum ? `（${p.enum.join(' / ')}）` : ''
    return `${label}${hint}`
  })
  const example = required.map(k => `${k}=xxx`).join(' ')
  return `请提供以下参数：${parts.join('，')}。\n示例：\`${example}\``
}

function waitForImMessage(platform: string, groupId: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      unregisterParamCollectWaiter(platform, groupId)
      reject(new Error('IM 参数采集超时（300s）'))
    }, COLLECTION_TIMEOUT_MS)

    registerParamCollectWaiter({
      platform, groupId,
      resolve: (msg: string) => {
        clearTimeout(timer)
        unregisterParamCollectWaiter(platform, groupId)
        resolve(msg)
      },
      reject: (err: Error) => {
        clearTimeout(timer)
        unregisterParamCollectWaiter(platform, groupId)
        reject(err)
      },
    })
  })
}

export async function collectImParams(
  platform: string,
  groupId: string,
  paramSchema: Record<string, unknown>,
  imPrompt?: string | null,
): Promise<Record<string, unknown>> {
  let collected: Record<string, unknown> = {}
  let prompt = buildPrompt(paramSchema, imPrompt)

  while (true) {
    const msgPromise = waitForImMessage(platform, groupId)
    await notifyImGroup(platform, groupId, prompt)
    const userMessage = await msgPromise

    const result = await consultImInputAgent({ userMessage, currentParams: collected, paramSchema })

    if (result.aborted) {
      await notifyImGroup(platform, groupId, '已取消。').catch(() => {})
      throw new Error('用户取消了参数采集')
    }

    collected = result.params

    if (result.done) return collected

    prompt = result.nextPrompt ?? buildPrompt(paramSchema)
  }
}
```

- [ ] **Step 4: 运行确认通过**

```bash
npx vitest run src/__tests__/unit/pipeline/im-param-collector.test.ts
```

Expected：PASS，5 tests

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/im-param-collector.ts src/__tests__/unit/pipeline/im-param-collector.test.ts
git commit -m "feat: im-param-collector multi-round IM param collection (TDD)"
```

---

### Task 7: session-manager — 路由优先查 ParamCollectWaiter

**Files:**
- Modify: `src/agent/session-manager.ts`

- [ ] **Step 1: 新增 import**

在 `src/agent/session-manager.ts` 顶部，已有：
```typescript
import { findImInputWaiter, resumeFromImInput } from '../pipeline/graph-runner.js'
```

在此行后追加：
```typescript
import { findParamCollectWaiter } from '../pipeline/im-router.js'
```

- [ ] **Step 2: 在 handleMessage 里加路由**

找到 `handleMessage` 里已有的 `findImInputWaiter` 块（约第 43 行）：

```typescript
const waiter = findImInputWaiter(msg.platform, msg.groupId)
if (waiter) {
  // ...
}
```

在这段**之前**插入：

```typescript
// 参数采集路由：优先于 graph interrupt waiter
const paramWaiter = findParamCollectWaiter(msg.platform, msg.groupId)
if (paramWaiter) {
  console.log(`[SessionManager] Routing to param-collector for ${msg.platform}:${msg.groupId}`)
  paramWaiter.resolve(msg.text)
  return
}
```

- [ ] **Step 3: 类型检查**

```bash
./test.sh --typecheck
```

Expected：0 errors

- [ ] **Step 4: Commit**

```bash
git add src/agent/session-manager.ts
git commit -m "feat: session-manager route IM messages to ParamCollectWaiter first"
```

---

### Task 8: coordinator — IM pipeline 触发前采集参数

**Files:**
- Modify: `src/agent/coordinator.ts`

- [ ] **Step 1: 找到 imTrigger.pipelineId 分支**

在 `src/agent/coordinator.ts` 约第 176 行，找到：
```typescript
if (imTrigger.pipelineId) {
  try {
    const { runPipeline, imTrigger: imTriggerCtx } = await import('../pipeline/executor.js')
    const runId = await runPipeline(
      imTrigger.pipelineId,
      {},
      imTriggerCtx({ ... }),
```

- [ ] **Step 2: 替换为先采集再 fire-and-forget 启动**

将整个 `if (imTrigger.pipelineId) { try { ... } }` 块替换为：

```typescript
if (imTrigger.pipelineId) {
  const pipelineId = imTrigger.pipelineId
  const platform = opts.context.platform
  const groupId = opts.context.groupId
  const initiatorId = opts.context.initiatorId

  // Fire-and-forget: 采集完参数后才 runPipeline，不阻塞 Agent session
  void (async () => {
    try {
      const { runPipeline, imTrigger: imTriggerCtx } = await import('../pipeline/executor.js')
      const { getTestPipelineById } = await import('../db/repositories/test-pipelines.js')
      const { collectImParams } = await import('../pipeline/im-param-collector.js')
      const { notifyImGroup } = await import('../pipeline/im-notifier.js')

      const pipeline = await getTestPipelineById(pipelineId)
      if (!pipeline) throw new Error(`Pipeline ${pipelineId} not found`)

      let params: Record<string, unknown> = opts.extraParams ?? {}
      if (pipeline.paramSchema) {
        params = await collectImParams(platform, groupId, pipeline.paramSchema, pipeline.imPrompt)
      }

      const runId = await runPipeline(
        pipelineId,
        {},
        imTriggerCtx({ triggeredBy: initiatorId, platform, groupId, userId: initiatorId, params }),
        {},
        undefined,
      )
      console.log(
        `[AgentCoordinator] pipeline run #${runId} started for "${opts.capabilityKey}" (via im_trigger)`,
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[AgentCoordinator] pipeline start failed for ${opts.capabilityKey}:`, msg)
      const { notifyImGroup } = await import('../pipeline/im-notifier.js')
      await notifyImGroup(platform, groupId, `❌ 流水线启动失败：${msg}`).catch(() => {})
    }
  })()

  return {
    success: true,
    output: pipeline?.paramSchema ? '正在采集参数，请按提示回复...' : `Pipeline run started`,
    data: { pipelineId },
  }
}
```

注意：上面代码里 `pipeline?.paramSchema` 需要在 void 块外取到，改为先同步查一次（或简化 return message）。实际实现简化为：

```typescript
if (imTrigger.pipelineId) {
  const pipelineId = imTrigger.pipelineId
  const platform = opts.context.platform
  const groupId = opts.context.groupId
  const initiatorId = opts.context.initiatorId

  void (async () => {
    try {
      const { runPipeline, imTrigger: imTriggerCtx } = await import('../pipeline/executor.js')
      const { getTestPipelineById } = await import('../db/repositories/test-pipelines.js')
      const { collectImParams } = await import('../pipeline/im-param-collector.js')

      const pipeline = await getTestPipelineById(pipelineId)
      if (!pipeline) throw new Error(`Pipeline ${pipelineId} not found`)

      let params: Record<string, unknown> = opts.extraParams ?? {}
      if (pipeline.paramSchema) {
        params = await collectImParams(platform, groupId, pipeline.paramSchema, pipeline.imPrompt)
      }

      await runPipeline(
        pipelineId,
        {},
        imTriggerCtx({ triggeredBy: initiatorId, platform, groupId, userId: initiatorId, params }),
        {},
        undefined,
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[AgentCoordinator] pipeline start failed for ${opts.capabilityKey}:`, msg)
      const { notifyImGroup } = await import('../pipeline/im-notifier.js')
      await notifyImGroup(platform, groupId, `❌ 流水线启动失败：${msg}`).catch(() => {})
    }
  })()

  return { success: true, output: '流水线触发中，如需参数将提示采集', data: { pipelineId } }
}
```

- [ ] **Step 3: 类型检查**

```bash
./test.sh --typecheck
```

Expected：0 errors

- [ ] **Step 4: Commit**

```bash
git add src/agent/coordinator.ts
git commit -m "feat: coordinator calls im-param-collector before runPipeline for IM trigger"
```

---

### Task 9: executor.ts — runPipeline 入口加 validateTriggerParams

**Files:**
- Modify: `src/pipeline/executor.ts`

- [ ] **Step 1: 新增 import**

在 `src/pipeline/executor.ts` 顶部 import 区域追加：

```typescript
import { validateTriggerParams } from './validate-trigger-params.js'
```

- [ ] **Step 2: 在 runPipeline 中加校验（在 pipeline 查询后）**

找到 `const pipeline = await getTestPipelineById(pipelineId)` 这行（约第 96 行）之后，在 `const productLine = ...` 之前插入：

```typescript
  // 非 IM 触发：校验 triggerParams 满足 paramSchema
  if (triggerType !== 'im' && pipeline.paramSchema) {
    const check = validateTriggerParams(pipeline.paramSchema, triggerParams)
    if (!check.valid) {
      throw new Error(`缺少必填触发参数：${check.missingFields.join(', ')}`)
    }
  }
```

- [ ] **Step 3: 类型检查**

```bash
./test.sh --typecheck
```

Expected：0 errors

- [ ] **Step 4: Commit**

```bash
git add src/pipeline/executor.ts
git commit -m "feat: executor validates triggerParams against paramSchema before run"
```

---

### Task 10: webhook-router — 参数校验 400

**Files:**
- Modify: `src/pipeline/webhook-router.ts`

- [ ] **Step 1: 在现有 pipeline 校验后插入 paramSchema 检查**

`webhook-router.ts` 第 33 行已有 `const pipeline = await getTestPipelineById(...)` 和 `if (!pipeline || !pipeline.enabled)` 检查。在该 if 块之后、步骤 4（校验 body）之前插入：

```typescript
      // paramSchema 校验：检查 payload 是否满足触发参数要求
      if (pipeline.paramSchema) {
        const { validateTriggerParams } = await import('./validate-trigger-params.js')
        const { servers: _s, payload: checkPayload } = extractServersFromPayload(
          rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody)
            ? rawBody as Record<string, unknown>
            : {}
        )
        const check = validateTriggerParams(pipeline.paramSchema, checkPayload)
        if (!check.valid) {
          return reply.status(400).send({
            error: '缺少必填触发参数',
            missingFields: check.missingFields,
          })
        }
      }
```

实际上 payload 在步骤 5 才解出，更简洁的做法是：在步骤 6（触发）前加校验，此时 `payload` 已经可用：

```typescript
      // 6a. paramSchema 校验
      if (pipeline.paramSchema) {
        const { validateTriggerParams } = await import('./validate-trigger-params.js')
        const check = validateTriggerParams(pipeline.paramSchema, payload)
        if (!check.valid) {
          return reply.status(400).send({ error: '缺少必填触发参数', missingFields: check.missingFields })
        }
      }

      // 6b. 触发（原有 runPipeline 调用，无需改动）
      const triggeredBy = `webhook:${webhook.id}:${webhook.name}`
      const runId = await runPipeline(...)
```

- [ ] **Step 3: 类型检查 + 全套测试**

```bash
./test.sh --typecheck
npx vitest run src/__tests__/unit/pipeline/webhook-router.test.ts 2>/dev/null || echo "(no existing test)"
```

- [ ] **Step 4: Commit**

```bash
git add src/pipeline/webhook-router.ts
git commit -m "feat: webhook-router returns 400 when required triggerParams missing"
```

---

### Task 11: scheduler.ts（TDD）

**Files:**
- Create: `src/pipeline/scheduler.ts`
- Create: `src/__tests__/unit/pipeline/scheduler.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// src/__tests__/unit/pipeline/scheduler.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('node-cron', () => ({
  default: {
    schedule: vi.fn(() => ({ destroy: vi.fn() })),
    validate: vi.fn(() => true),
  },
}))
vi.mock('../../db/repositories/pipeline-schedules.js', () => ({
  listEnabledSchedules: vi.fn(),
}))
vi.mock('../../pipeline/executor.js', () => ({
  runPipeline: vi.fn().mockResolvedValue(1),
  scheduledTrigger: vi.fn(args => ({ type: 'scheduled', ...args })),
}))

import cron from 'node-cron'
import { listEnabledSchedules } from '../../db/repositories/pipeline-schedules.js'
import { runPipeline, scheduledTrigger } from '../../pipeline/executor.js'
import { startPipelineScheduler, reloadSchedules } from '../../pipeline/scheduler.js'

beforeEach(() => { vi.clearAllMocks() })

describe('startPipelineScheduler', () => {
  it('registers cron tasks for all enabled schedules', async () => {
    vi.mocked(listEnabledSchedules).mockResolvedValue([
      { id: 1, pipelineId: 10, name: 'daily', cronExpr: '0 9 * * *', presetParams: { env: 'prod' }, enabled: true, createdAt: new Date(), updatedAt: new Date() },
    ])
    await startPipelineScheduler()
    expect(cron.schedule).toHaveBeenCalledWith('0 9 * * *', expect.any(Function), expect.anything())
  })

  it('reloadSchedules destroys old tasks and registers new ones', async () => {
    const destroy = vi.fn()
    vi.mocked(cron.schedule).mockReturnValue({ destroy } as any)
    vi.mocked(listEnabledSchedules).mockResolvedValue([
      { id: 1, pipelineId: 10, name: 'x', cronExpr: '* * * * *', presetParams: {}, enabled: true, createdAt: new Date(), updatedAt: new Date() },
    ])
    await startPipelineScheduler()
    await reloadSchedules()
    expect(destroy).toHaveBeenCalled()
    expect(cron.schedule).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] **Step 2: 运行确认失败**

```bash
npx vitest run src/__tests__/unit/pipeline/scheduler.test.ts
```

Expected：FAIL

- [ ] **Step 3: 实现**

先安装 node-cron：
```bash
pnpm add node-cron
pnpm add -D @types/node-cron
```

```typescript
// src/pipeline/scheduler.ts
import cron from 'node-cron'
import { listEnabledSchedules } from '../db/repositories/pipeline-schedules.js'
import { runPipeline, scheduledTrigger } from './executor.js'

let activeTasks: Array<{ destroy(): void }> = []

export async function startPipelineScheduler(): Promise<void> {
  await reloadSchedules()
  console.log('[PipelineScheduler] started')
}

export async function reloadSchedules(): Promise<void> {
  // Destroy existing tasks
  for (const t of activeTasks) t.destroy()
  activeTasks = []

  const schedules = await listEnabledSchedules()
  for (const s of schedules) {
    if (!cron.validate(s.cronExpr)) {
      console.warn(`[PipelineScheduler] invalid cron "${s.cronExpr}" for schedule #${s.id}, skipping`)
      continue
    }
    const task = cron.schedule(s.cronExpr, () => {
      void runPipeline(
        s.pipelineId,
        {},
        scheduledTrigger({ triggeredBy: `scheduler:${s.id}`, params: s.presetParams }),
      ).catch(err => {
        console.error(`[PipelineScheduler] schedule #${s.id} run failed:`, err)
      })
    }, { scheduled: true, timezone: 'Asia/Shanghai' })
    activeTasks.push(task)
  }

  console.log(`[PipelineScheduler] loaded ${activeTasks.length} schedule(s)`)
}
```

- [ ] **Step 4: 运行确认通过**

```bash
npx vitest run src/__tests__/unit/pipeline/scheduler.test.ts
```

Expected：PASS

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/scheduler.ts src/__tests__/unit/pipeline/scheduler.test.ts
git commit -m "feat: pipeline scheduler with node-cron (TDD)"
```

---

### Task 12: Admin API — pipeline-schedules CRUD

**Files:**
- Create: `src/admin/routes/pipeline-schedules.ts`
- Modify: `src/admin/index.ts`

- [ ] **Step 1: 创建路由文件**

```typescript
// src/admin/routes/pipeline-schedules.ts
import type { FastifyInstance } from 'fastify'
import {
  listPipelineSchedules,
  createPipelineSchedule,
  updatePipelineSchedule,
  deletePipelineSchedule,
  getPipelineScheduleById,
} from '../../db/repositories/pipeline-schedules.js'
import { getTestPipelineById } from '../../db/repositories/test-pipelines.js'
import { validateTriggerParams } from '../../pipeline/validate-trigger-params.js'
import { reloadSchedules } from '../../pipeline/scheduler.js'

export async function registerPipelineScheduleRoutes(app: FastifyInstance): Promise<void> {
  // List schedules for a pipeline
  app.get<{ Params: { id: string } }>('/test-pipelines/:id/schedules', async (req, reply) => {
    const schedules = await listPipelineSchedules(Number(req.params.id))
    return reply.send(schedules)
  })

  // Create schedule
  app.post<{ Params: { id: string }; Body: { name?: string; cronExpr: string; presetParams?: Record<string, unknown>; enabled?: boolean } }>(
    '/test-pipelines/:id/schedules',
    async (req, reply) => {
      const pipelineId = Number(req.params.id)
      const { name, cronExpr, presetParams = {}, enabled } = req.body

      const pipeline = await getTestPipelineById(pipelineId)
      if (!pipeline) return reply.status(404).send({ error: 'pipeline not found' })

      if (pipeline.paramSchema) {
        const check = validateTriggerParams(pipeline.paramSchema, presetParams)
        if (!check.valid) {
          return reply.status(400).send({ error: '预设参数不满足 paramSchema', missingFields: check.missingFields })
        }
      }

      const schedule = await createPipelineSchedule({ pipelineId, name, cronExpr, presetParams, enabled })
      await reloadSchedules()
      return reply.status(201).send(schedule)
    },
  )

  // Update schedule
  app.put<{ Params: { id: string; sid: string }; Body: Partial<{ name: string; cronExpr: string; presetParams: Record<string, unknown>; enabled: boolean }> }>(
    '/test-pipelines/:id/schedules/:sid',
    async (req, reply) => {
      const pipelineId = Number(req.params.id)
      const scheduleId = Number(req.params.sid)

      if (req.body.presetParams !== undefined) {
        const pipeline = await getTestPipelineById(pipelineId)
        if (pipeline?.paramSchema) {
          const check = validateTriggerParams(pipeline.paramSchema, req.body.presetParams)
          if (!check.valid) {
            return reply.status(400).send({ error: '预设参数不满足 paramSchema', missingFields: check.missingFields })
          }
        }
      }

      const updated = await updatePipelineSchedule(scheduleId, req.body)
      if (!updated) return reply.status(404).send({ error: 'schedule not found' })
      await reloadSchedules()
      return reply.send(updated)
    },
  )

  // Delete schedule
  app.delete<{ Params: { id: string; sid: string } }>(
    '/test-pipelines/:id/schedules/:sid',
    async (req, reply) => {
      const ok = await deletePipelineSchedule(Number(req.params.sid))
      if (!ok) return reply.status(404).send({ error: 'schedule not found' })
      await reloadSchedules()
      return reply.status(204).send()
    },
  )

  // Toggle enabled
  app.patch<{ Params: { id: string; sid: string }; Body: { enabled: boolean } }>(
    '/test-pipelines/:id/schedules/:sid/toggle',
    async (req, reply) => {
      const updated = await updatePipelineSchedule(Number(req.params.sid), { enabled: req.body.enabled })
      if (!updated) return reply.status(404).send({ error: 'schedule not found' })
      await reloadSchedules()
      return reply.send(updated)
    },
  )
}
```

- [ ] **Step 2: 注册到 admin/index.ts**

在 `src/admin/index.ts` 顶部 import 区追加：

```typescript
import { registerPipelineScheduleRoutes } from './routes/pipeline-schedules.js'
```

在函数体末尾（约第 90 行 `registerPipelineWebhookRoutes` 后）追加：

```typescript
  await registerPipelineScheduleRoutes(app)
```

- [ ] **Step 3: 类型检查**

```bash
./test.sh --typecheck
```

Expected：0 errors

- [ ] **Step 4: Commit**

```bash
git add src/admin/routes/pipeline-schedules.ts src/admin/index.ts
git commit -m "feat: admin API for pipeline schedule CRUD"
```

---

### Task 13: Admin API — pipeline paramSchema/imPrompt 读写

**Files:**
- Modify: `src/admin/routes/test-pipelines.ts`

- [ ] **Step 1: 找到 GET /test-pipelines/:id 的响应**

确认 `getTestPipelineById` 的返回值已被直接 send（`paramSchema`/`imPrompt` 会自动包含在内，因为 mapRow 已更新）。无需额外改动。

- [ ] **Step 2: 新增 PUT /test-pipelines/:id/settings 端点**

在 `src/admin/routes/test-pipelines.ts` 的 `registerTestPipelineRoutes` 函数末尾追加：

```typescript
  app.put<{
    Params: { id: string }
    Body: { paramSchema?: Record<string, unknown> | null; imPrompt?: string | null }
  }>('/test-pipelines/:id/settings', async (req, reply) => {
    const id = Number(req.params.id)
    const { paramSchema, imPrompt } = req.body
    const updated = await updateTestPipeline(id, { paramSchema, imPrompt })
    if (!updated) return reply.status(404).send({ error: 'not found' })
    return reply.send(updated)
  })
```

- [ ] **Step 3: 类型检查**

```bash
./test.sh --typecheck
```

Expected：0 errors

- [ ] **Step 4: Commit**

```bash
git add src/admin/routes/test-pipelines.ts
git commit -m "feat: admin API pipeline settings endpoint for paramSchema/imPrompt"
```

---

### Task 14: 启动 scheduler

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: 在 server.ts 启动时调用 startPipelineScheduler**

在 `src/server.ts` 找到 `startCleanupScheduler()` 调用附近，追加：

```typescript
import { startPipelineScheduler } from './pipeline/scheduler.js'
```

在启动初始化代码中（server.listen 附近）追加：

```typescript
await startPipelineScheduler()
```

- [ ] **Step 2: 类型检查**

```bash
./test.sh --typecheck
```

Expected：0 errors

- [ ] **Step 3: Commit**

```bash
git add src/server.ts
git commit -m "feat: start pipeline scheduler on server init"
```

---

### Task 15: 删除后端 im_input 代码

**Files:**
- Modify: `src/pipeline/graph-builder.ts`
- Modify: `src/pipeline/graph-runner.ts`
- Modify: `src/pipeline/types.ts`
- Modify: `src/agent/session-manager.ts`
- Delete: `src/pipeline/im-input-agent.ts`（迁移完成后）

- [ ] **Step 1: graph-builder.ts — 删除 im_input 相关代码**

搜索 `buildImInputNode`、`buildImInputDryRunNode`、`case 'im_input'`，全部删除。

具体位置（根据之前分析）：
- 约第 514 行起的 `buildImInputNode` 函数（整体删除）
- 约第 648 行起的 `buildImInputDryRunNode` 函数（整体删除）
- `case 'im_input':` 分支（整体删除）
- `IM_INPUT_INTERRUPT`、`IM_INPUT_TIMEOUT_SENTINEL`、`IM_INPUT_CANCEL_SENTINEL` 常量和 `ImInputInterruptValue` 类型定义（整体删除）

- [ ] **Step 2: graph-runner.ts — 删除 IM_INPUT_INTERRUPT 分支**

找到处理 `v.type === IM_INPUT_INTERRUPT` 的分支，整体删除。

- [ ] **Step 3: types.ts — 删除 ImInputConfig 和 'im_input'**

```typescript
// 从 StageDefinition.stageType union 中移除 'im_input'
// 删除 ImInputConfig 接口
// 删除 StageDefinition.imInputConfig 字段
```

- [ ] **Step 4: session-manager.ts — 删除 graph-runner waiter 引用**

移除：
```typescript
import { findImInputWaiter, resumeFromImInput } from '../pipeline/graph-runner.js'
```

以及 `handleMessage` 中的 `findImInputWaiter` / `resumeFromImInput` 块（已在 Task 7 保留的代码中）。

- [ ] **Step 5: 运行全套测试**

```bash
./test.sh
```

修复因删除 `im_input` 导致的测试引用断裂（fixture 里有 `im_input` stage 的需要更新）。

- [ ] **Step 6: Commit**

```bash
git add -p  # 逐块确认删除
git commit -m "feat: remove im_input node type from graph-builder/runner/types"
```

---

### Task 16: 前端删除 im_input

**Files:**
- Modify: `web/src/types/index.ts`
- Modify: `web/src/pipeline-canvas/types.ts`
- Modify: `web/src/pipeline-canvas/PipelineCanvasPage.tsx`
- Modify: `web/src/pipeline-canvas/panels/NodeInspector.tsx`
- Modify: `web/src/pipeline-canvas/graph-validation.ts`
- Modify: `web/src/pipeline-canvas/panels/pruneStageFields.ts`

- [ ] **Step 1: web/src/types/index.ts — 新增 paramSchema/imPrompt**

在 `web/src/types/index.ts` 的 `TestPipeline` interface（第 67 行）新增两个字段：

```typescript
export interface TestPipeline {
  id: number; productLineId?: number; name: string; description: string
  graph?: unknown | null
  stages: StageDefinition[]; serverRoles?: Record<string, { count: number }>
  variables?: Record<string, string>
  artifactInputs?: ArtifactInput[]
  containerImage?: string | null
  paramSchema?: Record<string, unknown> | null   // 新增
  imPrompt?: string | null                        // 新增
  schedule?: string; enabled: boolean; triggerParams: Record<string, unknown>; createdAt: string; updatedAt: string
}
```

- [ ] **Step 2: web/src/pipeline-canvas/types.ts — 删除 'im_input' 和 ImInputConfig**

```typescript
// 从 StageType union 移除 'im_input'
// 从 STAGE_TYPES 数组移除 'im_input'
// 删除 ImInputConfig 接口
// 从 StageFields 删除 imInputConfig 字段
```

- [ ] **Step 3: PipelineCanvasPage.tsx — 删除 im_input 初始化分支**

找到 `type === 'im_input'` 的条件（约第 77-82 行），删除整个分支。  
找到 `case 'im_input': return 'IM 输入'`，删除此 case。

找到 `node.data.stageType === 'im_input'` 的所有分支，删除。

- [ ] **Step 4: graph-validation.ts — 删除 im_input 校验**

找到 `d.stageType === 'im_input'` 的判断，删除整个 if 块。

- [ ] **Step 5: pruneStageFields.ts — 删除 im_input case**

删除 `case 'im_input':` 分支和 `im_input: ['imInputConfig']` 映射。

- [ ] **Step 6: 前端类型检查**

```bash
cd web && pnpm build
```

Expected：0 TypeScript errors

- [ ] **Step 7: Commit**

```bash
git add web/src/pipeline-canvas/
git commit -m "feat: remove im_input node type from frontend canvas"
```

---

### Task 17: 前端 — ParamSchemaForm 动态表单组件

**Files:**
- Create: `web/src/pipeline-canvas/panels/ParamSchemaForm.tsx`

这个组件被手动触发 Modal 和 Schedule 预设参数表单复用。

- [ ] **Step 1: 创建组件**

```tsx
// web/src/pipeline-canvas/panels/ParamSchemaForm.tsx
import { Form, Input, Select, Switch, InputNumber } from 'antd'

interface SchemaProperty {
  type?: string
  enum?: string[]
  title?: string
  description?: string
}

interface JsonSchema {
  properties?: Record<string, SchemaProperty>
  required?: string[]
}

interface Props {
  schema: JsonSchema
  /** antd Form instance，由调用方传入以便外部提交 */
  form: ReturnType<typeof Form.useForm>[0]
  initialValues?: Record<string, unknown>
}

export function ParamSchemaForm({ schema, form, initialValues }: Props) {
  const props = schema.properties ?? {}
  const required = schema.required ?? []

  return (
    <Form form={form} layout="vertical" initialValues={initialValues}>
      {Object.entries(props).map(([key, prop]) => {
        const isRequired = required.includes(key)
        const label = prop.title ?? key
        const rules = isRequired ? [{ required: true, message: `请填写 ${label}` }] : []

        let input: React.ReactNode
        if (prop.enum) {
          input = (
            <Select showSearch options={prop.enum.map(v => ({ value: v, label: v }))} />
          )
        } else if (prop.type === 'boolean') {
          input = <Switch />
        } else if (prop.type === 'number' || prop.type === 'integer') {
          input = <InputNumber style={{ width: '100%' }} />
        } else {
          input = <Input />
        }

        return (
          <Form.Item
            key={key}
            name={key}
            label={label}
            rules={rules}
            tooltip={prop.description}
            valuePropName={prop.type === 'boolean' ? 'checked' : 'value'}
          >
            {input}
          </Form.Item>
        )
      })}
    </Form>
  )
}
```

- [ ] **Step 2: 类型检查**

```bash
cd web && pnpm build
```

Expected：0 errors

- [ ] **Step 3: Commit**

```bash
git add web/src/pipeline-canvas/panels/ParamSchemaForm.tsx
git commit -m "feat: ParamSchemaForm renders Ant Design form from JSON Schema"
```

---

### Task 18: 前端 — 手动触发 Modal 集成 ParamSchemaForm

**Files:**
- Modify: `web/src/pipeline-canvas/dryrun/DryRunStartModal.tsx`（或触发 Modal 所在位置）
- Modify: `web/src/pipeline-canvas/PipelineCanvasPage.tsx`（触发逻辑）

- [ ] **Step 1: 找到手动触发入口**

在 `PipelineCanvasPage.tsx` 找到调用 `triggerTestRun({ pipelineId, servers: {}, triggerType: 'manual' })` 的地方（约第 178/238 行）。

- [ ] **Step 2: 新增 ManualTriggerModal 组件（内联或新文件）**

如果当前无参数 schema 直接触发，现在改为：若 pipeline 有 `paramSchema` 则先弹 Modal 收参；否则直接触发。

在 `PipelineCanvasPage.tsx` 中：

```tsx
// 在 handleRunPipeline（或对应函数）里：
const pipeline = /* 已有的 pipeline 对象 */
if (pipeline.paramSchema && Object.keys(pipeline.paramSchema.properties ?? {}).length > 0) {
  // 弹 Modal
  setManualTriggerVisible(true)
} else {
  // 直接触发
  await triggerTestRun({ pipelineId, servers: {}, triggerType: 'manual' })
}
```

ManualTriggerModal（内联 Modal）：

```tsx
<Modal
  title="触发参数"
  open={manualTriggerVisible}
  onOk={async () => {
    try {
      const values = await paramForm.validateFields()
      await triggerTestRun({ pipelineId, servers: {}, triggerType: 'manual', params: values })
      setManualTriggerVisible(false)
    } catch {}
  }}
  onCancel={() => setManualTriggerVisible(false)}
>
  <ParamSchemaForm schema={pipeline.paramSchema!} form={paramForm} />
</Modal>
```

同时在 `triggerTestRun` 的 API 调用里，把 `params` 透传到 request body（更新 `web/src/pipeline-canvas/api.ts` 的 `triggerTestRun` 函数签名和请求 body）。

- [ ] **Step 3: 更新 triggerTestRun API**

在 `web/src/pipeline-canvas/api.ts` 找到 `triggerTestRun`，新增 `params` 字段：

```typescript
export async function triggerTestRun(data: {
  pipelineId: number
  servers: Record<string, string[]>
  triggerType?: 'manual' | 'api'
  params?: Record<string, unknown>
}): Promise<{ runId: number }> {
  const res = await axios.post('/admin/test-runs', data)
  return res.data
}
```

并确认 `src/admin/routes/test-runs.ts` 的触发端点能接收 `params` 并透传到 `manualTrigger({ ..., params })`。

- [ ] **Step 4: 前端类型检查**

```bash
cd web && pnpm build
```

Expected：0 errors

- [ ] **Step 5: Commit**

```bash
git add web/src/pipeline-canvas/
git commit -m "feat: manual trigger modal renders ParamSchemaForm when paramSchema set"
```

---

### Task 19: 前端 — TriggerParamsPanel + SchedulesPanel

**Files:**
- Create: `web/src/pipeline-canvas/panels/TriggerParamsPanel.tsx`
- Create: `web/src/pipeline-canvas/panels/SchedulesPanel.tsx`
- Modify: `web/src/pipeline-canvas/panels/PipelineSettingsPanel.tsx`

- [ ] **Step 1: 创建 TriggerParamsPanel**

```tsx
// web/src/pipeline-canvas/panels/TriggerParamsPanel.tsx
import { useState } from 'react'
import { Button, Form, Input, Space, Typography, message } from 'antd'
import axios from 'axios'

// 简单 JSON Schema 编辑器：直接编辑 JSON（v1 用 textarea，后续可升级 monaco）
interface Props {
  pipelineId: number
  paramSchema: Record<string, unknown> | null
  imPrompt: string | null
  onSaved: (paramSchema: Record<string, unknown> | null, imPrompt: string | null) => void
}

export function TriggerParamsPanel({ pipelineId, paramSchema, imPrompt, onSaved }: Props) {
  const [schemaText, setSchemaText] = useState(
    paramSchema ? JSON.stringify(paramSchema, null, 2) : ''
  )
  const [prompt, setPrompt] = useState(imPrompt ?? '')
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    let schema: Record<string, unknown> | null = null
    if (schemaText.trim()) {
      try { schema = JSON.parse(schemaText) }
      catch { message.error('paramSchema JSON 格式有误'); return }
    }
    setSaving(true)
    try {
      await axios.put(`/admin/test-pipelines/${pipelineId}/settings`, {
        paramSchema: schema,
        imPrompt: prompt.trim() || null,
      })
      onSaved(schema, prompt.trim() || null)
      message.success('已保存')
    } finally { setSaving(false) }
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Typography.Text type="secondary">
        触发参数 Schema（JSON Schema 格式）。空白表示此流水线无需参数采集。
      </Typography.Text>
      <Input.TextArea
        rows={10}
        value={schemaText}
        onChange={e => setSchemaText(e.target.value)}
        placeholder={'{\n  "properties": { "env": { "title": "环境", "enum": ["dev","prod"] } },\n  "required": ["env"]\n}'}
        style={{ fontFamily: 'monospace', fontSize: 12 }}
      />
      <Form.Item label="IM 引导语（可选）" style={{ marginBottom: 0 }}>
        <Input
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          placeholder="留空则自动从 Schema 生成"
        />
      </Form.Item>
      <Button type="primary" loading={saving} onClick={handleSave}>保存</Button>
    </Space>
  )
}
```

- [ ] **Step 2: 创建 SchedulesPanel**

```tsx
// web/src/pipeline-canvas/panels/SchedulesPanel.tsx
import { useEffect, useState } from 'react'
import { Button, Form, Input, Modal, Space, Switch, Table, message } from 'antd'
import axios from 'axios'
import { ParamSchemaForm } from './ParamSchemaForm.js'

interface Schedule {
  id: number; name: string; cronExpr: string; presetParams: Record<string, unknown>; enabled: boolean
}

interface Props {
  pipelineId: number
  paramSchema: Record<string, unknown> | null
}

export function SchedulesPanel({ pipelineId, paramSchema }: Props) {
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Schedule | null>(null)
  const [form] = Form.useForm()
  const [paramForm] = Form.useForm()

  async function load() {
    const res = await axios.get<Schedule[]>(`/admin/test-pipelines/${pipelineId}/schedules`)
    setSchedules(res.data)
  }

  useEffect(() => { void load() }, [pipelineId])

  async function handleSave() {
    const base = await form.validateFields()
    const params = paramSchema ? await paramForm.validateFields() : {}
    const data = { ...base, presetParams: params }
    if (editing) {
      await axios.put(`/admin/test-pipelines/${pipelineId}/schedules/${editing.id}`, data)
    } else {
      await axios.post(`/admin/test-pipelines/${pipelineId}/schedules`, data)
    }
    message.success('已保存')
    setModalOpen(false)
    await load()
  }

  async function handleDelete(id: number) {
    await axios.delete(`/admin/test-pipelines/${pipelineId}/schedules/${id}`)
    await load()
  }

  async function handleToggle(id: number, enabled: boolean) {
    await axios.patch(`/admin/test-pipelines/${pipelineId}/schedules/${id}/toggle`, { enabled })
    await load()
  }

  return (
    <>
      <Button type="primary" onClick={() => { setEditing(null); form.resetFields(); paramForm.resetFields(); setModalOpen(true) }}>
        新增规则
      </Button>
      <Table
        dataSource={schedules}
        rowKey="id"
        size="small"
        style={{ marginTop: 8 }}
        columns={[
          { title: '名称', dataIndex: 'name' },
          { title: 'Cron', dataIndex: 'cronExpr' },
          { title: '启用', dataIndex: 'enabled', render: (v, r) => (
            <Switch checked={v} onChange={checked => void handleToggle(r.id, checked)} />
          )},
          { title: '操作', render: (_, r) => (
            <Space>
              <a onClick={() => { setEditing(r); form.setFieldsValue(r); paramForm.setFieldsValue(r.presetParams); setModalOpen(true) }}>编辑</a>
              <a onClick={() => void handleDelete(r.id)} style={{ color: 'red' }}>删除</a>
            </Space>
          )},
        ]}
      />
      <Modal
        title={editing ? '编辑规则' : '新增规则'}
        open={modalOpen}
        onOk={handleSave}
        onCancel={() => setModalOpen(false)}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="名称"><Input /></Form.Item>
          <Form.Item name="cronExpr" label="Cron 表达式" rules={[{ required: true }]}>
            <Input placeholder="0 9 * * *" />
          </Form.Item>
        </Form>
        {paramSchema && Object.keys(paramSchema.properties ?? {}).length > 0 && (
          <>
            <Typography.Text type="secondary">预设参数</Typography.Text>
            <ParamSchemaForm schema={paramSchema as any} form={paramForm} />
          </>
        )}
      </Modal>
    </>
  )
}
```

（需要在文件顶部补 `import { Typography } from 'antd'`）

- [ ] **Step 3: 改造 PipelineSettingsPanel — 从单 Form 转为 Tabs 布局**

当前 `PipelineSettingsPanel.tsx` 是一个纯 Form，没有 Tabs。将整个文件替换为：

```tsx
import { Form, Input, Button, message, Tabs } from 'antd'
import { updateTestPipeline } from '../../api/test-pipelines'
import type { TestPipeline } from '../../types'
import { TriggerParamsPanel } from './TriggerParamsPanel.js'
import { SchedulesPanel } from './SchedulesPanel.js'

interface Props {
  pipeline: TestPipeline
  onSaved: (updated: TestPipeline) => void
}

export default function PipelineSettingsPanel({ pipeline, onSaved }: Props) {
  const [form] = Form.useForm<{ containerImage: string }>()

  const handleSave = async () => {
    const values = await form.validateFields()
    const image = values.containerImage?.trim() ?? ''
    try {
      const updated = await updateTestPipeline(pipeline.id, { containerImage: image || null })
      onSaved(updated)
      void message.success('已保存')
    } catch {
      void message.error('保存失败')
    }
  }

  const items = [
    {
      key: 'general',
      label: '基础设置',
      children: (
        <Form form={form} layout="vertical" initialValues={{ containerImage: pipeline.containerImage ?? '' }}>
          <Form.Item
            name="containerImage"
            label="默认容器镜像"
            extra="script 节点无 role 时使用此 image 在本机 Docker 容器内执行；留空则关闭 Docker 模式"
          >
            <Input placeholder="例如：node:18、harbor.internal/myapp:latest" allowClear />
          </Form.Item>
          <Form.Item>
            <Button type="primary" onClick={handleSave}>保存</Button>
          </Form.Item>
        </Form>
      ),
    },
    {
      key: 'trigger-params',
      label: '触发参数',
      children: (
        <TriggerParamsPanel
          pipelineId={pipeline.id}
          paramSchema={pipeline.paramSchema ?? null}
          imPrompt={pipeline.imPrompt ?? null}
          onSaved={(schema, prompt) => onSaved({ ...pipeline, paramSchema: schema, imPrompt: prompt })}
        />
      ),
    },
    {
      key: 'schedules',
      label: '定时规则',
      children: (
        <SchedulesPanel pipelineId={pipeline.id} paramSchema={pipeline.paramSchema ?? null} />
      ),
    },
  ]

  return <Tabs items={items} />
}
```

- [ ] **Step 4: 前端完整构建**

```bash
cd web && pnpm build
```

Expected：0 errors

- [ ] **Step 5: Commit**

```bash
git add web/src/pipeline-canvas/panels/
git commit -m "feat: TriggerParamsPanel + SchedulesPanel in PipelineSettingsPanel"
```

---

### Task 20: 最终验证

- [ ] **Step 1: 全套测试**

```bash
./test.sh
```

Expected：全部 PASS

- [ ] **Step 2: 前端构建**

```bash
cd web && pnpm build
```

Expected：0 errors，产物输出到 `web/dist`

- [ ] **Step 3: 冒烟测试（手动）**

1. 在画布「触发参数」Tab 配置 `{ "properties": { "env": { "enum": ["dev","prod"] } }, "required": ["env"] }`
2. 点击「运行」→ 弹出 Modal，选择 env=prod，确认 → pipeline 正常启动
3. 在「定时规则」Tab 新增规则（测试用随意 cron），查看 server 日志确认 scheduler 注册
4. 通过 webhook POST 缺少 env 参数 → 返回 400 + missingFields

- [ ] **Step 4: 最终 commit（若有遗留修改）**

```bash
git add .
git commit -m "chore: final cleanup after pipeline param schema migration"
```
