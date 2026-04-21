# IM-Driven Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 IM（钉钉/飞书）对话触发的能力从"直接裸跑 Agent"改造成"启动 Pipeline（首节点是参数澄清 Agent 节点）"，让 IM 触发的操作具备 pipeline 的容错/审批/回滚/等待能力，同时保留 Agent 的智能澄清。

**Architecture:**
- 新增 `im_input` pipeline stage 类型，通过 LangGraph 的 `interrupt()` 等待 IM 消息，消息抵达后交给一个轻量 Agent 判断"参数齐全 / 还需追问"，齐全则把结构化参数作为 stage 输出传给后续节点。
- `capabilities` 表加 `default_pipeline_id` 绑定；IM 消息触达某 capability 时，有绑定就 `runPipeline()`，没有就降级到旧的 `triggerCapability()`。
- 新增 `pipeline-im-router`：维护 `(platform, groupId) → runId/stageIndex` 映射，IM adapter 收到消息先查路由，命中则调 `graph-runner.resumeRun()`，否则走原 SessionManager。
- Pipeline 进度（阶段开始/成功/失败、审批请求）通过已有 hooks + 新增 `onImNotify` 回调推回 IM 群。

**Tech Stack:** TypeScript + Fastify + LangGraph (`@langchain/langgraph`) + PostgreSQL + Vitest

**Related Prior Plan:** `docs/superpowers/plans/2026-04-14-unified-capability-pipeline.md`（已完成 capability-as-stage 的前置工作）

---

## File Structure

**New files:**
- `src/db/schema-v13.sql` — 加 `capabilities.default_pipeline_id`
- `src/pipeline/im-router.ts` — IM 消息 → pipeline run 的路由注册表
- `src/pipeline/im-input-agent.ts` — `im_input` 节点用的轻量 Agent（参数判定）
- `src/pipeline/im-notifier.ts` — pipeline 进度 → IM 群的回推通道
- `src/__tests__/unit/pipeline/im-router.test.ts`
- `src/__tests__/unit/pipeline/im-input-agent.test.ts`
- `src/__tests__/integration/im-triggered-pipeline.test.ts`

**Modified files:**
- `src/pipeline/types.ts` — `StageDefinition.stageType` 加 `'im_input'`，新增 `imInputConfig` 字段
- `src/pipeline/graph-builder.ts` — `buildImInputNode` + `IM_INPUT_INTERRUPT`
- `src/pipeline/graph-runner.ts` — 识别并路由 `IM_INPUT_INTERRUPT`
- `src/pipeline/executor.ts` — `triggerType` 加 `'im'`
- `src/db/repositories/capabilities.ts` — 加 `defaultPipelineId` 读写
- `src/agent/coordinator.ts` — `triggerCapability()` 改为"有绑定 pipeline 则 `runPipeline()`，否则走 handler"
- `src/adapters/im/*` — 收到消息先过 `pipeline-im-router`

---

### Task 1: Schema v13 — capabilities.default_pipeline_id

**Files:**
- Create: `src/db/schema-v13.sql`
- Modify: `src/db/migrate.ts`

- [ ] **Step 1: 创建 schema-v13.sql**

```sql
-- ============================================================
-- schema-v13: Bind a default pipeline to a capability (IM-triggered)
-- ============================================================

ALTER TABLE capabilities
  ADD COLUMN IF NOT EXISTS default_pipeline_id INTEGER REFERENCES test_pipelines(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_capabilities_default_pipeline
  ON capabilities(default_pipeline_id) WHERE default_pipeline_id IS NOT NULL;
```

- [ ] **Step 2: 把 v13 追加到 migrate.ts**

在 `src/db/migrate.ts` 找到最后一个 `pool.query(schemaVN)` 调用，紧随其后加：

```typescript
const schemaV13 = readFileSync(join(__dirname, 'schema-v13.sql'), 'utf8')
await pool.query(schemaV13)
```

把最终成功日志里的版本号更新到 `v13`。

- [ ] **Step 3: 本地运行迁移验证**

Run: `docker compose up -d postgres && sleep 3 && pnpm migrate`

Expected: 无错误，日志含 `✅ Database schema applied`。

Verify: `docker compose exec postgres psql -U chatops -c "\d capabilities" | grep default_pipeline_id`

Expected: 输出 `default_pipeline_id | integer | ... REFERENCES test_pipelines(id)`。

- [ ] **Step 4: 提交**

```bash
git add src/db/schema-v13.sql src/db/migrate.ts
git commit -m "feat(db): schema-v13 add capabilities.default_pipeline_id"
```

---

### Task 2: Capabilities Repository — 读写 defaultPipelineId

**Files:**
- Modify: `src/db/repositories/capabilities.ts`
- Test: `src/__tests__/unit/capabilities-repo.test.ts` (若不存在则新建)

- [ ] **Step 1: 写失败测试**

创建或追加到 `src/__tests__/unit/capabilities-repo.test.ts`：

```typescript
import { describe, it, expect, beforeAll } from 'vitest'
import { createCapability, getCapabilityByKey, updateCapabilityPipelineBinding } from '../../db/repositories/capabilities.js'
import { initTestDb, cleanTestDb } from '../helpers/test-db.js'

describe('capabilities.defaultPipelineId', () => {
  beforeAll(async () => { await initTestDb() })

  it('defaults to null on new capability', async () => {
    await cleanTestDb()
    const cap = await createCapability({
      key: 'foo', displayName: 'foo', description: '', category: 'action',
      toolNames: [], needsApproval: false,
    })
    expect(cap.defaultPipelineId).toBeNull()
  })

  it('updateCapabilityPipelineBinding sets and clears the binding', async () => {
    await cleanTestDb()
    const cap = await createCapability({
      key: 'bar', displayName: 'bar', description: '', category: 'action',
      toolNames: [], needsApproval: false,
    })
    await updateCapabilityPipelineBinding(cap.id, 42)
    const got1 = await getCapabilityByKey('bar')
    expect(got1?.defaultPipelineId).toBe(42)

    await updateCapabilityPipelineBinding(cap.id, null)
    const got2 = await getCapabilityByKey('bar')
    expect(got2?.defaultPipelineId).toBeNull()
  })
})
```

- [ ] **Step 2: 运行测试看红**

Run: `npx vitest run src/__tests__/unit/capabilities-repo.test.ts`

Expected: FAIL，原因 `updateCapabilityPipelineBinding is not a function` 或 `defaultPipelineId` 缺失。

- [ ] **Step 3: 实现**

修改 `src/db/repositories/capabilities.ts`：

在 `Capability` 接口增加 `defaultPipelineId: number | null`；`mapRow` 增加 `defaultPipelineId: (r.default_pipeline_id ?? null) as number | null`。

追加函数：

```typescript
export async function updateCapabilityPipelineBinding(
  id: number,
  pipelineId: number | null,
): Promise<Capability | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    `UPDATE capabilities SET default_pipeline_id = $2, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id, pipelineId],
  )
  return rows[0] ? mapRow(rows[0]) : null
}
```

- [ ] **Step 4: 运行测试看绿 + 类型检查**

Run:
```
npx vitest run src/__tests__/unit/capabilities-repo.test.ts
npx tsc --noEmit
```

Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git add src/db/repositories/capabilities.ts src/__tests__/unit/capabilities-repo.test.ts
git commit -m "feat(capabilities): add defaultPipelineId binding CRUD"
```

---

### Task 3: Pipeline Types — 新增 im_input stage

**Files:**
- Modify: `src/pipeline/types.ts`

- [ ] **Step 1: 扩展 StageDefinition**

将 `stageType` 联合加上 `'im_input'`，新增可选 `imInputConfig`：

```typescript
export interface ImInputConfig {
  /** 首次引导语；支持 {{triggerParams.xxx}} */
  prompt: string
  /** 需要采集的参数 JSON Schema（properties+required） */
  paramSchema: Record<string, unknown>
  /** 可选：用于加载 system_prompt / tool 白名单来增强 Agent 判断 */
  capabilityKey?: string
  /** 收集超时（秒），超过则 stage 失败 */
  timeoutSeconds?: number
}

export interface StageDefinition {
  name: string
  stageType: 'script' | 'approval' | 'capability' | 'wait_webhook' | 'im_input'
  targetRoles: string[]
  parallel: boolean
  timeoutSeconds: number
  retryCount: number
  onFailure: 'stop' | 'continue'
  script?: string
  approverIds?: string[]
  approvalDescription?: string
  capabilityKey?: string
  capabilityParams?: Record<string, unknown>
  webhookTag?: string
  imInputConfig?: ImInputConfig
}

export function getStageType(
  stage: StageDefinition,
): 'script' | 'approval' | 'capability' | 'wait_webhook' | 'im_input' {
  return stage.stageType ?? 'script'
}
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`

Expected: 无错误。任何 `switch (stageType)` 漏 case 的地方会报"not exhaustive"，在那些地方显式加 `default` 抛错或 TODO 标注，后续 Task 处理。

- [ ] **Step 3: 提交**

```bash
git add src/pipeline/types.ts
git commit -m "feat(pipeline): introduce im_input stage type"
```

---

### Task 4: IM Router — pipeline run 的 IM 会话注册表

**Files:**
- Create: `src/pipeline/im-router.ts`
- Create: `src/__tests__/unit/pipeline/im-router.test.ts`

该模块是无状态的纯内存 map，负责"IM 群→正在等输入的 pipeline run"双向映射。

- [ ] **Step 1: 写失败测试**

```typescript
// src/__tests__/unit/pipeline/im-router.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import {
  registerImWaiter, unregisterImWaiter,
  findRunExpectingInput, isGroupBusy,
} from '../../../pipeline/im-router.js'

describe('im-router', () => {
  beforeEach(() => {
    unregisterImWaiter({ runId: 1, stageIndex: 0 })
    unregisterImWaiter({ runId: 2, stageIndex: 0 })
  })

  it('registers and finds a waiter by (platform, groupId)', () => {
    registerImWaiter({
      runId: 1, stageIndex: 0,
      platform: 'dingtalk', groupId: 'g1',
    })
    expect(findRunExpectingInput('dingtalk', 'g1')).toEqual({ runId: 1, stageIndex: 0 })
    expect(findRunExpectingInput('dingtalk', 'g-other')).toBeNull()
  })

  it('isGroupBusy returns true while a waiter is registered', () => {
    expect(isGroupBusy('dingtalk', 'g2')).toBe(false)
    registerImWaiter({ runId: 2, stageIndex: 0, platform: 'dingtalk', groupId: 'g2' })
    expect(isGroupBusy('dingtalk', 'g2')).toBe(true)
    unregisterImWaiter({ runId: 2, stageIndex: 0 })
    expect(isGroupBusy('dingtalk', 'g2')).toBe(false)
  })

  it('unregister removes only the matching waiter', () => {
    registerImWaiter({ runId: 1, stageIndex: 0, platform: 'dingtalk', groupId: 'g1' })
    registerImWaiter({ runId: 2, stageIndex: 0, platform: 'dingtalk', groupId: 'g2' })
    unregisterImWaiter({ runId: 1, stageIndex: 0 })
    expect(findRunExpectingInput('dingtalk', 'g1')).toBeNull()
    expect(findRunExpectingInput('dingtalk', 'g2')).toEqual({ runId: 2, stageIndex: 0 })
  })
})
```

- [ ] **Step 2: 运行测试看红**

Run: `npx vitest run src/__tests__/unit/pipeline/im-router.test.ts`

Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 im-router.ts**

```typescript
// src/pipeline/im-router.ts
/**
 * im-router — 维护"正在等 IM 输入的 pipeline run"注册表。
 *
 * IM adapter 收到消息时先查 findRunExpectingInput()，命中则把消息作为
 * resumeValue 调 graph-runner.resumeRun()；否则走普通 SessionManager。
 *
 * 纯内存实现：pipeline 的 interrupt 状态本身已持久化在 checkpointer 里，
 * 这里只需要记录"哪个群的下一条消息应该喂给哪个 run"。进程重启后若
 * 存在未完成的 im_input interrupt，重放 interrupt payload 即可重建。
 */

export interface ImWaiterKey {
  runId: number
  stageIndex: number
}

export interface ImWaiter extends ImWaiterKey {
  platform: string
  groupId: string
}

const byRun = new Map<string, ImWaiter>()        // `${runId}:${stageIndex}`
const byGroup = new Map<string, ImWaiter>()      // `${platform}:${groupId}`

const runKey = (k: ImWaiterKey) => `${k.runId}:${k.stageIndex}`
const groupKey = (platform: string, groupId: string) => `${platform}:${groupId}`

export function registerImWaiter(w: ImWaiter): void {
  // 若目标群已有 waiter，先移除以避免错路由
  const existing = byGroup.get(groupKey(w.platform, w.groupId))
  if (existing) {
    byRun.delete(runKey(existing))
  }
  byRun.set(runKey(w), w)
  byGroup.set(groupKey(w.platform, w.groupId), w)
}

export function unregisterImWaiter(k: ImWaiterKey): void {
  const w = byRun.get(runKey(k))
  if (!w) return
  byRun.delete(runKey(k))
  byGroup.delete(groupKey(w.platform, w.groupId))
}

export function findRunExpectingInput(platform: string, groupId: string): ImWaiterKey | null {
  const w = byGroup.get(groupKey(platform, groupId))
  return w ? { runId: w.runId, stageIndex: w.stageIndex } : null
}

export function isGroupBusy(platform: string, groupId: string): boolean {
  return byGroup.has(groupKey(platform, groupId))
}

export function listWaiters(): ImWaiter[] {
  return Array.from(byRun.values())
}
```

- [ ] **Step 4: 运行测试看绿**

Run: `npx vitest run src/__tests__/unit/pipeline/im-router.test.ts`

Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git add src/pipeline/im-router.ts src/__tests__/unit/pipeline/im-router.test.ts
git commit -m "feat(pipeline): add im-router in-memory registry for IM-driven stages"
```

---

### Task 5: IM Input Agent — 轻量参数判定

**Files:**
- Create: `src/pipeline/im-input-agent.ts`
- Create: `src/__tests__/unit/pipeline/im-input-agent.test.ts`

该模块决定一件事：给定当前已采集参数 + 用户刚说的话 + 参数 schema，输出 `{done: boolean, params: {...}, nextPrompt?: string}`。

**决策**：第一版用**确定性合并**而不是调用 Claude——对已知场景（project/env/branch 这种）用启发式提取即可，避免 IM 每条消息都起一个 Claude 子进程。Claude 版本作为 fallback，走 `capabilityKey` 字段显式开启。

- [ ] **Step 1: 写失败测试**

```typescript
// src/__tests__/unit/pipeline/im-input-agent.test.ts
import { describe, it, expect } from 'vitest'
import { consultImInputAgent } from '../../../pipeline/im-input-agent.js'

const schema = {
  type: 'object',
  required: ['project', 'env', 'branch'],
  properties: {
    project: { type: 'string', title: '模块' },
    env:     { type: 'string', title: '环境', enum: ['dev', 'staging', 'prod'] },
    branch:  { type: 'string', title: '分支' },
  },
}

describe('consultImInputAgent (heuristic mode)', () => {
  it('marks done when the user message contains all required values in key=value form', async () => {
    const r = await consultImInputAgent({
      userMessage: 'project=web-app env=dev branch=feature/login',
      currentParams: {},
      paramSchema: schema,
    })
    expect(r.done).toBe(true)
    expect(r.params).toEqual({ project: 'web-app', env: 'dev', branch: 'feature/login' })
  })

  it('merges with existing params and prompts for missing ones', async () => {
    const r = await consultImInputAgent({
      userMessage: 'branch=main',
      currentParams: { project: 'api', env: 'dev' },
      paramSchema: schema,
    })
    expect(r.done).toBe(true)
    expect(r.params.branch).toBe('main')
  })

  it('asks for the first missing required param when the message is unparseable', async () => {
    const r = await consultImInputAgent({
      userMessage: '帮我部署一下',
      currentParams: {},
      paramSchema: schema,
    })
    expect(r.done).toBe(false)
    expect(r.nextPrompt).toMatch(/模块|project/)
  })

  it('rejects enum values outside the schema and re-prompts', async () => {
    const r = await consultImInputAgent({
      userMessage: 'env=production',
      currentParams: { project: 'web-app', branch: 'main' },
      paramSchema: schema,
    })
    expect(r.done).toBe(false)
    expect(r.nextPrompt).toMatch(/dev|staging|prod/)
  })

  it('accepts `cancel` / `取消` as explicit abort', async () => {
    const r = await consultImInputAgent({
      userMessage: '取消',
      currentParams: { project: 'web-app' },
      paramSchema: schema,
    })
    expect(r.aborted).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试看红**

Run: `npx vitest run src/__tests__/unit/pipeline/im-input-agent.test.ts`

Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

```typescript
// src/pipeline/im-input-agent.ts
/**
 * im-input-agent — 决策器：判断当前 im_input stage 是否参数齐全。
 *
 * 第一版：启发式 key=value 解析 + 缺失字段提示。
 * 后续可扩展：若 imInputConfig.capabilityKey 存在，fallback 到 Claude。
 */

export interface ConsultInput {
  userMessage: string
  currentParams: Record<string, unknown>
  paramSchema: Record<string, unknown>
}

export interface ConsultResult {
  done: boolean
  aborted?: boolean
  params: Record<string, unknown>
  nextPrompt?: string
}

const ABORT_WORDS = new Set(['cancel', 'abort', '取消', '退出', 'quit'])

export async function consultImInputAgent(input: ConsultInput): Promise<ConsultResult> {
  const msg = input.userMessage.trim()
  if (ABORT_WORDS.has(msg.toLowerCase())) {
    return { done: false, aborted: true, params: input.currentParams }
  }

  const props = (input.paramSchema.properties ?? {}) as Record<string, {
    type?: string; enum?: string[]; title?: string
  }>
  const required = (input.paramSchema.required ?? []) as string[]

  // 解析 key=value 形式，值允许空格/引号
  const merged: Record<string, unknown> = { ...input.currentParams }
  const kvRe = /(\w+)\s*=\s*("[^"]+"|\S+)/g
  let m: RegExpExecArray | null
  while ((m = kvRe.exec(msg)) !== null) {
    const key = m[1]
    const rawVal = m[2].startsWith('"') ? m[2].slice(1, -1) : m[2]
    if (key in props) merged[key] = rawVal
  }

  // 单字段模式：若 message 不含 `=` 且只缺一个必填项，把整条消息作为值
  if (!msg.includes('=')) {
    const missing = required.filter(k => merged[k] === undefined || merged[k] === '')
    if (missing.length === 1) merged[missing[0]] = msg
  }

  // 校验 enum 约束
  for (const [key, prop] of Object.entries(props)) {
    if (prop.enum && merged[key] !== undefined && !prop.enum.includes(merged[key] as string)) {
      const label = prop.title ?? key
      return {
        done: false,
        params: merged,
        nextPrompt: `${label} 的取值必须是：${prop.enum.join(' / ')}，请重新输入。`,
      }
    }
  }

  // 找第一个缺失项
  const firstMissing = required.find(k => merged[k] === undefined || merged[k] === '')
  if (firstMissing) {
    const prop = props[firstMissing]
    const label = prop?.title ?? firstMissing
    const enumHint = prop?.enum ? `（可选：${prop.enum.join(' / ')}）` : ''
    return {
      done: false,
      params: merged,
      nextPrompt: `请提供 ${label}${enumHint}。可以直接回值，也可以 \`${firstMissing}=xxx\`。回 \`取消\` 可中止。`,
    }
  }

  return { done: true, params: merged }
}
```

- [ ] **Step 4: 跑测试看绿**

Run: `npx vitest run src/__tests__/unit/pipeline/im-input-agent.test.ts`

Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git add src/pipeline/im-input-agent.ts src/__tests__/unit/pipeline/im-input-agent.test.ts
git commit -m "feat(pipeline): add heuristic im-input-agent for param collection"
```

---

### Task 6: Graph Builder — im_input 节点

**Files:**
- Modify: `src/pipeline/graph-builder.ts`

该节点进入时：
1. 查看 stage 已收集参数（写在 state）
2. 如果已全 → 立刻 return 成功（用于 resume 后跳过）
3. 否则发起 `interrupt({kind: IM_INPUT_INTERRUPT, ...})` 等 IM 消息
4. resume 后把消息喂 `consultImInputAgent`，done 则返回成功，否则继续 interrupt

- [ ] **Step 1: 加 interrupt 常量和类型**

在 `src/pipeline/graph-builder.ts` 顶部已有常量块后增加：

```typescript
export const IM_INPUT_INTERRUPT = 'im_input' as const

export interface ImInputInterruptValue {
  kind: typeof IM_INPUT_INTERRUPT
  runId: number
  stageIndex: number
  stageName: string
  platform: string
  groupId: string
  prompt: string                    // 当前要展示给用户的问题
  paramSchema: Record<string, unknown>
  collectedSoFar: Record<string, unknown>
  timeoutSeconds: number
}
```

- [ ] **Step 2: 实现 buildImInputNode**

在 `graph-builder.ts` 的 stage handler builders 区域加：

```typescript
import { interrupt } from '@langchain/langgraph'
import { consultImInputAgent } from './im-input-agent.js'
import type { ImInputConfig, StageDefinition } from './types.js'

function buildImInputHandler(
  stage: StageDefinition,
  stageIndex: number,
  ctx: StageContextBase,
) {
  return async (state: PipelineState): Promise<Partial<PipelineState>> => {
    const cfg = stage.imInputConfig
    if (!cfg) {
      return {
        stageResults: [{
          stageIndex, stageName: stage.name, status: 'failed',
          output: 'imInputConfig missing', startedAt: new Date(),
          finishedAt: new Date(),
        }],
      }
    }

    // 若 stage 已有 collectedParams（resume 时）则以此为起点
    const prev = state.stageResults?.[stageIndex]
    let collected: Record<string, unknown> =
      (prev?.collectedParams as Record<string, unknown> | undefined) ?? {}
    let nextPrompt = cfg.prompt
    const startedAt = prev?.startedAt ?? new Date()

    // 多轮 interrupt 循环
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const userMessage = interrupt<ImInputInterruptValue, string>({
        kind: IM_INPUT_INTERRUPT,
        runId: ctx.runId,
        stageIndex,
        stageName: stage.name,
        platform: ctx.triggerPlatform ?? '',
        groupId: ctx.triggerGroupId ?? '',
        prompt: nextPrompt,
        paramSchema: cfg.paramSchema,
        collectedSoFar: collected,
        timeoutSeconds: cfg.timeoutSeconds ?? 600,
      })

      const r = await consultImInputAgent({
        userMessage,
        currentParams: collected,
        paramSchema: cfg.paramSchema,
      })

      if (r.aborted) {
        return {
          stageResults: [{
            stageIndex, stageName: stage.name, status: 'failed',
            output: '用户取消', startedAt,
            finishedAt: new Date(),
            collectedParams: r.params,
          }],
        }
      }

      collected = r.params
      if (r.done) {
        return {
          stageResults: [{
            stageIndex, stageName: stage.name, status: 'success',
            output: JSON.stringify(collected),
            startedAt, finishedAt: new Date(),
            collectedParams: collected,
          }],
          // 把采集到的参数并入 triggerParams，供下游 stage 的变量解析使用
          triggerParams: { ...(state.triggerParams ?? {}), ...collected },
        }
      }
      nextPrompt = r.nextPrompt ?? cfg.prompt
      // 回到循环顶，下一次 interrupt 会用新 prompt
    }
  }
}
```

- [ ] **Step 3: 在节点分发器中挂上 im_input**

找到 `buildGraphFromStages` / `buildGraphFromPipeline` 里按 `stageType` 分发的 `switch`，增加：

```typescript
case 'im_input':
  return buildImInputHandler(stage, stageIndex, ctx)
```

- [ ] **Step 4: 扩展 StageContextBase**

在 `graph-builder.ts` 的 `StageContextBase` 接口加可选字段：

```typescript
triggerPlatform?: string
triggerGroupId?: string
```

以便 handler 拿到当前 IM 会话位置。executor.ts 传入时填。

- [ ] **Step 5: 更新 StageResult 持久化**

在 `src/db/repositories/test-runs.ts` 的 `StageResult` 类型加可选 `collectedParams?: Record<string, unknown>`；在 mapRow / updateTestRunStage 里做 JSON 序列化。

- [ ] **Step 6: 验证编译**

Run: `npx tsc --noEmit`

Expected: 无错误。若 `switch (stageType)` 非穷尽被其他地方抛错，对应补齐。

- [ ] **Step 7: 提交**

```bash
git add src/pipeline/graph-builder.ts src/pipeline/types.ts src/db/repositories/test-runs.ts
git commit -m "feat(pipeline): build im_input node with interrupt loop"
```

---

### Task 7: Graph Runner — 派发 IM_INPUT_INTERRUPT

**Files:**
- Modify: `src/pipeline/graph-runner.ts`

- [ ] **Step 1: 在 interrupt 分发逻辑加分支**

定位 `graph-runner.ts` 中处理 `APPROVAL_INTERRUPT` / `WEBHOOK_INTERRUPT` 的 switch（搜 `interrupt.kind`），加入：

```typescript
import { registerImWaiter, unregisterImWaiter } from './im-router.js'
import { IM_INPUT_INTERRUPT, type ImInputInterruptValue } from './graph-builder.js'
import { notifyImGroup } from './im-notifier.js'

// ... in the interrupt dispatcher:
if (value.kind === IM_INPUT_INTERRUPT) {
  const v = value as ImInputInterruptValue
  registerImWaiter({
    runId: v.runId,
    stageIndex: v.stageIndex,
    platform: v.platform,
    groupId: v.groupId,
  })
  // 把 prompt 发到 IM 群
  await notifyImGroup(v.platform, v.groupId, v.prompt)

  const timer = setTimeout(async () => {
    // 超时：clean up + 标 stage 失败，通过 resumeRun 传一个特殊 sentinel
    unregisterImWaiter({ runId: v.runId, stageIndex: v.stageIndex })
    await notifyImGroup(v.platform, v.groupId, `⌛ 超时未收到回复，取消本次任务`)
    await resumeRun(v.runId, '取消') // consultImInputAgent 识别为 abort
  }, v.timeoutSeconds * 1000)
  interruptTimers.set(interruptKey(v.runId, v.stageIndex), timer)
  return // 等 IM 消息来调 resumeRun
}
```

- [ ] **Step 2: resumeRun 成功返回后清理 waiter**

找到 `resumeRun()` 函数，在已有 "clear approvalTimer" 的位置附近补：

```typescript
unregisterImWaiter({ runId, stageIndex })
clearInterruptTimer(interruptKey(runId, stageIndex))
```

- [ ] **Step 3: 验证编译**

Run: `npx tsc --noEmit`

Expected: 无错误。

- [ ] **Step 4: 提交**

```bash
git add src/pipeline/graph-runner.ts
git commit -m "feat(pipeline): dispatch IM_INPUT_INTERRUPT via im-router"
```

---

### Task 8: IM Notifier — pipeline → IM 群消息回推

**Files:**
- Create: `src/pipeline/im-notifier.ts`

pipeline 需要把 prompt 和进度推到 IM 群。这里做一个 adapter-agnostic 的转发层，由 IM adapters 在启动时注册发送函数。

- [ ] **Step 1: 创建 im-notifier.ts**

```typescript
// src/pipeline/im-notifier.ts
/**
 * im-notifier — 让 pipeline 的节点/runner 可以向 IM 群发送消息。
 *
 * IM adapters（dingtalk/feishu）启动时调 registerImSender 注入发送函数。
 * 若某平台未注册，notifyImGroup 仅打 log，不抛错（避免阻断流程）。
 */

type SendFn = (groupId: string, text: string) => Promise<void>

const senders = new Map<string, SendFn>()

export function registerImSender(platform: string, fn: SendFn): void {
  senders.set(platform, fn)
}

export async function notifyImGroup(platform: string, groupId: string, text: string): Promise<void> {
  const fn = senders.get(platform)
  if (!fn) {
    console.warn(`[im-notifier] no sender registered for platform="${platform}"`)
    return
  }
  try {
    await fn(groupId, text)
  } catch (err) {
    console.error(`[im-notifier] send failed platform=${platform} group=${groupId}:`, err)
  }
}
```

- [ ] **Step 2: 在现有 IM adapter 中注册**

在 `src/adapters/im/dingtalk.ts`（或实际文件名）启动初始化处加：

```typescript
import { registerImSender } from '../../pipeline/im-notifier.js'

// adapter init:
registerImSender('dingtalk', async (groupId, text) => {
  await adapter.sendText(groupId, text)
})
```

对 feishu adapter 同样处理。

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit`

- [ ] **Step 4: 提交**

```bash
git add src/pipeline/im-notifier.ts src/adapters/im/
git commit -m "feat(pipeline): add im-notifier bridge between pipeline and IM adapters"
```

---

### Task 9: IM Adapter — 消息优先进 pipeline router

**Files:**
- Modify: `src/adapters/im/dingtalk.ts`（和 feishu 对应文件）

- [ ] **Step 1: 定位消息入口**

找到每个 adapter 接收到用户消息的入口（通常是 `onMessage(msg)` 或类似 handler），在进入 SessionManager 之前插入 pipeline 路由分支：

```typescript
import { findRunExpectingInput } from '../../pipeline/im-router.js'
import { resumeRun } from '../../pipeline/graph-runner.js'

// 入口函数内部，最前面：
const waiter = findRunExpectingInput('dingtalk', groupId)
if (waiter) {
  await resumeRun(waiter.runId, messageText)
  return
}
// ... 原有 SessionManager 逻辑
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`

- [ ] **Step 3: 提交**

```bash
git add src/adapters/im/
git commit -m "feat(im): route messages to pipeline im-router first"
```

---

### Task 10: Executor — 支持 triggerType='im' 与 IM 上下文

**Files:**
- Modify: `src/pipeline/executor.ts`
- Modify: `src/pipeline/graph-runner.ts`
- Modify: `src/pipeline/graph-builder.ts`

- [ ] **Step 1: 扩展 triggerType**

在 `executor.ts` 和 `graph-runner.ts` 的类型里把 `triggerType` 联合加 `'im'`：

```typescript
triggerType: 'manual' | 'api' | 'scheduled' | 'im'
```

- [ ] **Step 2: 新增 imContext 参数**

`runPipeline()` 签名增加可选 `imContext`：

```typescript
export interface ImTriggerContext {
  platform: string
  groupId: string
  userId: string
}

export async function runPipeline(
  pipelineId: number,
  serverAssignment: Record<string, string[]>,
  triggerType: 'manual' | 'api' | 'scheduled' | 'im',
  triggeredBy: string,
  runtimeVarsInput: Record<string, string> = {},
  onComplete?: (result: PipelineRunResult) => void,
  triggerParams?: Record<string, unknown>,
  imContext?: ImTriggerContext,
): Promise<number> { ... }
```

- [ ] **Step 3: 把 imContext 注入 StageContextBase**

构造 `stageContext` 时把 `triggerPlatform`/`triggerGroupId` 填入：

```typescript
const stageContext: StageContextBase = {
  ...existing,
  triggerPlatform: imContext?.platform,
  triggerGroupId: imContext?.groupId,
}
```

- [ ] **Step 4: 类型检查 + 跑现有 pipeline 测试**

Run:
```
npx tsc --noEmit
npx vitest run src/__tests__/unit/pipeline
```

Expected: 所有现有测试仍通过（新参数都可选）。

- [ ] **Step 5: 提交**

```bash
git add src/pipeline/executor.ts src/pipeline/graph-runner.ts src/pipeline/graph-builder.ts
git commit -m "feat(pipeline): add triggerType='im' and imContext"
```

---

### Task 11: Coordinator — capability 绑定 pipeline 时走 runPipeline

**Files:**
- Modify: `src/agent/coordinator.ts`

- [ ] **Step 1: 改造 triggerCapability**

在 `triggerCapability()` 中，拿到 capability 后判断：

```typescript
export async function triggerCapability(opts: TriggerOptions): Promise<TriggerResult> {
  const capability = await getCapabilityByKey(opts.capabilityKey)
  if (!capability) return { success: false, error: `capability not found: ${opts.capabilityKey}` }

  // 新：绑定了 pipeline → 启动 pipeline
  if (capability.defaultPipelineId) {
    const runId = await runPipeline(
      capability.defaultPipelineId,
      {},                                   // IM 场景通常不预分配服务器，由 pipeline 内部处理
      'im',
      opts.context.initiatorId,
      {},                                   // runtimeVars 走 triggerParams
      undefined,                            // onComplete 交给 im-notifier 推送
      opts.extraParams ?? {},               // 已知参数作为初始 triggerParams
      {
        platform: opts.context.platform,
        groupId: opts.context.groupId,
        userId: opts.context.initiatorId,
      },
    )
    return { success: true, output: `Pipeline run #${runId} started`, data: { runId } }
  }

  // 旧路径降级
  const handler = handlers.get(opts.capabilityKey)
  if (!handler) return { success: false, error: `no handler registered for: ${opts.capabilityKey}` }
  return handler(opts)
}
```

注意 `import { runPipeline } from '../pipeline/executor.js'` 可能造成循环依赖（executor-hooks 已 import coordinator）。若 tsc 报循环，把 `runPipeline` 调用放进 lazy `await import()`。

- [ ] **Step 2: 运行期测试（手动）**

Run: `pnpm dev`，通过 admin API 或直接 psql 给 `deploy` capability 绑一条真实 pipeline_id。在 IM 群 @机器人 "deploy"，验证走 pipeline 路径：群里收到 "Pipeline run #N started" 及 stage 进度回推。

- [ ] **Step 3: 提交**

```bash
git add src/agent/coordinator.ts
git commit -m "feat(agent): triggerCapability routes to pipeline when binding exists"
```

---

### Task 12: 样板 Pipeline — deploy_v2

**Files:**
- Modify: `src/db/schema-v13.sql`（直接扩写 seed，或新建 `src/db/seeds/deploy-pipeline.sql`）

- [ ] **Step 1: 在 schema-v13.sql 末尾插入样板 pipeline**

```sql
-- Seed a demo deploy pipeline (IM-driven)
INSERT INTO test_pipelines (product_line_id, name, description, stages, server_roles, enabled, trigger_params)
SELECT pl.id, 'deploy-im-demo', 'IM 驱动的部署流水线（参数澄清 + 审批 + 部署 + 健康检查）',
  $$[
    {
      "name": "参数澄清",
      "stageType": "im_input",
      "targetRoles": [],
      "parallel": false,
      "timeoutSeconds": 600,
      "retryCount": 0,
      "onFailure": "stop",
      "imInputConfig": {
        "prompt": "请告诉我：模块 / 环境 / 分支。可以一次性写 `project=xxx env=dev branch=main`，也可以分开逐条回。",
        "paramSchema": {
          "type": "object",
          "required": ["project", "env", "branch"],
          "properties": {
            "project": {"type":"string","title":"模块"},
            "env":     {"type":"string","title":"环境","enum":["dev","staging","prod"]},
            "branch":  {"type":"string","title":"分支"}
          }
        },
        "timeoutSeconds": 600
      }
    },
    {
      "name": "部署审批",
      "stageType": "approval",
      "targetRoles": [],
      "parallel": false,
      "timeoutSeconds": 1800,
      "retryCount": 0,
      "onFailure": "stop",
      "approvalDescription": "部署 {{triggerParams.project}} 到 {{triggerParams.env}} 分支 {{triggerParams.branch}}"
    },
    {
      "name": "执行部署",
      "stageType": "capability",
      "targetRoles": [],
      "parallel": false,
      "timeoutSeconds": 1200,
      "retryCount": 0,
      "onFailure": "stop",
      "capabilityKey": "deploy",
      "capabilityParams": {
        "project": "{{triggerParams.project}}",
        "env":     "{{triggerParams.env}}",
        "branch":  "{{triggerParams.branch}}"
      }
    }
  ]$$::jsonb,
  '{}'::jsonb, true, '{}'::jsonb
FROM product_lines pl
WHERE pl.name = 'default'
ON CONFLICT (product_line_id, name) DO NOTHING;

-- 把 deploy capability 绑到这条 pipeline
UPDATE capabilities
SET default_pipeline_id = (SELECT id FROM test_pipelines WHERE name = 'deploy-im-demo')
WHERE key = 'deploy' AND default_pipeline_id IS NULL;
```

- [ ] **Step 2: 迁移**

Run: `pnpm migrate`

Verify:
```
docker compose exec postgres psql -U chatops -c "SELECT key, default_pipeline_id FROM capabilities WHERE key='deploy';"
```

Expected: 返回 `deploy | <non-null>`。

- [ ] **Step 3: 提交**

```bash
git add src/db/schema-v13.sql
git commit -m "feat(seed): demo IM-driven deploy pipeline wired to deploy capability"
```

---

### Task 13: 集成测试 — 端到端 IM → Pipeline → 完成

**Files:**
- Create: `src/__tests__/integration/im-triggered-pipeline.test.ts`

**设计**：用一个内存 adapter 模拟 IM，组合 coordinator → runPipeline → im-router → resumeRun 全链路。stage 用纯 `im_input` + 一个 `script` stub（mock ssh）。

- [ ] **Step 1: 写集成测试**

```typescript
// src/__tests__/integration/im-triggered-pipeline.test.ts
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { registerImSender } from '../../pipeline/im-notifier.js'
import { findRunExpectingInput } from '../../pipeline/im-router.js'
import { resumeRun } from '../../pipeline/graph-runner.js'
import { triggerCapability } from '../../agent/coordinator.js'
import { initTestDb, seedCapabilityWithPipeline } from '../helpers/test-db.js'

describe('IM-triggered pipeline end-to-end', () => {
  const received: Array<{ groupId: string; text: string }> = []

  beforeAll(async () => { await initTestDb() })
  beforeEach(() => {
    received.length = 0
    registerImSender('test', async (groupId, text) => {
      received.push({ groupId, text })
    })
  })

  it('runs deploy pipeline via IM: prompt → user reply → stage success', async () => {
    const { capabilityKey } = await seedCapabilityWithPipeline()

    const triggerPromise = triggerCapability({
      capabilityKey,
      context: {
        taskId: 't1', groupId: 'g1', platform: 'test',
        initiatorId: 'user1', initiatorRole: 'ops',
      },
    })
    const first = await triggerPromise
    expect(first.success).toBe(true)

    // 等一拍让 graph 进 interrupt
    await new Promise(r => setTimeout(r, 100))

    // pipeline 应注册了 IM waiter
    expect(findRunExpectingInput('test', 'g1')).not.toBeNull()
    // 应收到 prompt
    expect(received.some(m => /模块.*环境.*分支|project.*env.*branch/.test(m.text))).toBe(true)

    // 用户回一条完整参数
    const w = findRunExpectingInput('test', 'g1')!
    await resumeRun(w.runId, 'project=demo env=dev branch=main')

    await new Promise(r => setTimeout(r, 200))
    // waiter 应清理
    expect(findRunExpectingInput('test', 'g1')).toBeNull()
  }, 10000)
})
```

`src/__tests__/helpers/test-db.ts` 若没有 `seedCapabilityWithPipeline` 则添加：

```typescript
export async function seedCapabilityWithPipeline(): Promise<{ capabilityKey: string }> {
  // 插入一条只有 im_input 节点的 pipeline + 一个绑它的 capability
  // 实现略，用 pool.query 建 minimal row
}
```

- [ ] **Step 2: 跑测试**

Run: `npx vitest run src/__tests__/integration/im-triggered-pipeline.test.ts`

Expected: 全绿。若 approval/capability 节点需要真实依赖，样板 pipeline 只用 im_input + 一个 noop capability 即可。

- [ ] **Step 3: 提交**

```bash
git add src/__tests__/integration/im-triggered-pipeline.test.ts src/__tests__/helpers/test-db.ts
git commit -m "test(integration): IM → pipeline → im_input → resume end-to-end"
```

---

### Task 14: 前端 — capability 编辑页增加"默认 Pipeline"字段

**Files:**
- Modify: `web/src/api/capabilities.ts`
- Modify: `web/src/pages/CapabilitiesPage.tsx`
- Modify: `src/admin/routes/capabilities.ts`

- [ ] **Step 1: 后端 route 支持更新绑定**

在 `src/admin/routes/capabilities.ts` 加：

```typescript
app.put('/capabilities/:id/pipeline-binding', async (req, reply) => {
  const id = Number((req.params as { id: string }).id)
  const { pipelineId } = req.body as { pipelineId: number | null }
  const updated = await updateCapabilityPipelineBinding(id, pipelineId)
  return reply.send(updated)
})
```

import `updateCapabilityPipelineBinding`。

- [ ] **Step 2: 前端 API 层**

`web/src/api/capabilities.ts` 增加：

```typescript
export const updateCapabilityPipelineBinding = (id: number, pipelineId: number | null) =>
  client.put(`/capabilities/${id}/pipeline-binding`, { pipelineId }).then(r => r.data)
```

`Capability` 接口加 `defaultPipelineId: number | null`。

- [ ] **Step 3: 编辑页增加下拉**

`CapabilitiesPage.tsx` 的编辑 Modal 中增加字段：

```tsx
<Form.Item name="defaultPipelineId" label="默认 Pipeline（IM 触发时走此流水线）">
  <Select
    allowClear
    placeholder="未绑定则走 Agent 直接处理"
    options={pipelines.map(p => ({ value: p.id, label: p.name }))}
  />
</Form.Item>
```

在 page 加载时拉 `getTestPipelines()` 存到 `pipelines` state。submit 时额外调 `updateCapabilityPipelineBinding`。

- [ ] **Step 4: 前端类型检查 + 手动验证**

Run:
```
cd web && npx tsc --noEmit
pnpm dev
```

打开 Capabilities 页面，编辑 `deploy`，下拉选 `deploy-im-demo`，保存。

Verify: `psql` 确认 `default_pipeline_id` 已写。

- [ ] **Step 5: 提交**

```bash
git add web/src/api/capabilities.ts web/src/pages/CapabilitiesPage.tsx src/admin/routes/capabilities.ts
git commit -m "feat(web): capability edit modal supports default pipeline binding"
```

---

### Task 15: 冒烟验证手册 + 文档更新

**Files:**
- Create: `docs/smoke-im-pipeline.md`
- Modify: `CLAUDE.md`（Architecture 章节）

- [ ] **Step 1: 写冒烟手册**

```markdown
# 冒烟：IM 驱动的 Pipeline

## 前置
- 数据库已 migrate 到 v13
- `deploy` capability 已绑 `deploy-im-demo` pipeline（schema-v13 自动 seed）
- 钉钉/飞书 adapter 已启动

## 步骤 1：IM 发消息触发
群里 @机器人："deploy"

**预期**：
- 群里收到 "Pipeline run #N started"
- 紧接着收到 im_input 节点的 prompt："请告诉我：模块 / 环境 / 分支..."

## 步骤 2：缺参数（走澄清循环）
回："project=demo"

**预期**：机器人继续追问 env。

## 步骤 3：填错 env
回："env=production"

**预期**：机器人提示"环境 的取值必须是：dev / staging / prod"。

## 步骤 4：补完 + 完成澄清
回："env=dev branch=main"

**预期**：im_input 节点成功，pipeline 进入下一 approval 节点，群里发来审批请求卡片。

## 步骤 5：取消场景
重新触发，回 "取消"。

**预期**：pipeline stage 标为 failed，群里发 "用户取消"。

## 步骤 6：超时场景
触发后 10 分钟不回。

**预期**：群里收到 "⌛ 超时未收到回复，取消本次任务"，pipeline failed。
```

- [ ] **Step 2: 更新 CLAUDE.md 架构章节**

在 "Architecture" 章节的请求流图后面增加一段：

```markdown
### IM-Driven Pipeline Flow

当 IM 消息触达某 capability 时：
1. `coordinator.triggerCapability()` 检查 `capabilities.default_pipeline_id`
2. 有绑定 → `runPipeline(triggerType='im', imContext={platform,groupId,userId})`
3. pipeline 首节点通常是 `im_input` stage（`graph-builder.buildImInputHandler`），通过 `interrupt()` 等待 IM 消息
4. `graph-runner` 把 interrupt 注册到 `pipeline/im-router.ts`
5. 下一条 IM 消息先被 adapter 查 `im-router`，命中则 `resumeRun(runId, messageText)` 继续图执行
6. `im-input-agent` 判定参数齐全后，参数作为 `triggerParams` 合入 state 供后续 stage 引用
7. 后续 stage（approval / capability / script）照常执行，进度通过 `im-notifier` 推回群
```

- [ ] **Step 3: 提交**

```bash
git add docs/smoke-im-pipeline.md CLAUDE.md
git commit -m "docs: IM-driven pipeline smoke manual and architecture update"
```

---

## Verification Checklist

全部任务完成后逐条验证：

1. **Migration**：`pnpm migrate` → `✅ Database schema applied (... + v13)`
2. **单元测试**：`pnpm test` → 全绿（含新的 im-router / im-input-agent / capabilities-repo）
3. **集成测试**：`npx vitest run src/__tests__/integration/im-triggered-pipeline.test.ts` → 绿
4. **TypeScript**：`npx tsc --noEmit` + `cd web && npx tsc --noEmit` → 无错误
5. **手动冒烟**：按 `docs/smoke-im-pipeline.md` 六步跑一遍
6. **回归**：原 `pnpm test` 套件中涉及 pipeline 的用例全部通过（说明新路径没破坏旧路径）
7. **前端**：Capabilities 页面能看到并编辑"默认 Pipeline"绑定

---

## Self-Review 备注

- 风险点 1：`coordinator` 与 `executor` 可能循环依赖（executor-hooks 已 import coordinator）。若 Task 11 tsc 报错，把 `runPipeline` 改为 `await import('../pipeline/executor.js')` 动态引入。
- 风险点 2：进程重启时 pipeline 还在 im_input interrupt 中，`im-router` 内存丢失。checkpointer 里的 interrupt payload 还在，但群里新消息无法路由到 run——v1 可接受（由超时兜底），v2 可做"进程启动时扫描所有 pending interrupt 重建 im-router"。
- 风险点 3：同一群并发触发两条 pipeline 时 `im-router` 只能路由给最新一条（见 registerImWaiter 内的清理逻辑）。v1 可接受；v2 可让 `isGroupBusy` 在 coordinator 入口处直接拒绝新请求并回群。
- 未覆盖：`capabilityKey` 字段的 Claude fallback 模式（im-input-agent 只做启发式）。留给下一轮迭代。
- 复用：`CLAUDE.md` 里 Task 15 的文档段落应该指向 `2026-04-14-unified-capability-pipeline-design.md` 获取 capability-as-stage 背景。
