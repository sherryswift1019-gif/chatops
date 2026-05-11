# QI Pipeline Retry Advanced (Sub-plan E.1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Sub-plan E "失败节点自动 retry" 基础上加 3 个增强：retry 计数上限（防无限重试）+ 节点列表 timeline UI（详情抽屉展示每节点状态）+ `retryFromNode(runId, fromNodeId)` 让用户**从任意节点回退**重跑（spec §5.5 `invalidate_downstream` 模式）。

**Architecture:** 分 3 个 phase 渐进：
- **Phase 1（safe）**：retry 计数 + 节点列表 read-only timeline UI — 纯 DB/UI 改动，无 LangGraph 风险
- **Phase 2（experimental）**：`retryFromNode` 后端用 LangGraph `compiled.updateState({channel_values}, asNode)` 实验性截断 state — 有技术风险，可能 BLOCKED 退化为「仅 DB 截断 + 重 resume」简化方案
- **Phase 3（UI dependent）**：节点级 retry button 接 Phase 2 endpoint

如 Phase 2 BLOCKED，Phase 1 可独立上线，Phase 3 推迟。

**Tech Stack:** TypeScript ES2022 + LangGraph + PostgresSaver + Fastify + React 18 + Ant Design Timeline + Vitest

**Spec:** [docs/superpowers/specs/2026-05-11-qi-pipeline-topology-design.md](../specs/2026-05-11-qi-pipeline-topology-design.md) §5.5 'invalidate_downstream' 模式
**前置 Sub-plan E:** [docs/superpowers/plans/2026-05-11-qi-pipeline-node-retry-sub-plan-e.md](2026-05-11-qi-pipeline-node-retry-sub-plan-e.md) §Outstanding follow-up

**Out of Scope（本 plan 不涉及）：**
- E2E sandbox 4 拆 + VM 改造（独立大议题）
- Pipeline 定义热更新（QI v14+ 才考虑）
- 跨 interrupt 的 retry（人审 waiter 超时重发卡片）

---

## File Structure

**Create:**
- `src/__tests__/integration/qi-retry-from-node.test.ts` — Phase 2+3 集成测试
- `src/__tests__/unit/qi-retry-cap.test.ts` — Phase 1 retry cap 单测
- `web/src/components/StageResultsTimeline.tsx` — Phase 1+3 节点列表组件

**Modify:**
- `src/db/repositories/requirements.ts` — 加 `incrementNodeRetryCount(reqId, nodeId)` + `getNodeRetryCount(reqId, nodeId)`
- `src/pipeline/graph-runner.ts` — 加 `retryFromNode(runId, fromNodeId)` 函数；改 `retryFailedRun` 加 retry cap check
- `src/admin/routes/requirements.ts` — 加 `POST /requirements/:id/retry-from-node`；改现有 `POST /requirements/:id/retry` 加 cap 错误处理
- `web/src/api/requirements.ts` — 加 `retryFromNode(id, fromNodeId)` 方法
- `web/src/pages/RequirementsPage.tsx` — 详情抽屉嵌入 StageResultsTimeline

---

## Phase 1: Retry 计数上限 + 节点列表 timeline UI

### Task 1: retry cap repository helpers + retryFailedRun 集成

**Files:**
- Modify: `src/db/repositories/requirements.ts`
- Modify: `src/pipeline/graph-runner.ts` — `retryFailedRun` 加 cap check
- Create: `src/__tests__/unit/qi-retry-cap.test.ts`

### Steps

- [ ] **Step 1.1: 探查 retry_counters 现状**

```bash
grep -n "retry_counters\|retryCounters" src/db/repositories/requirements.ts src/db/schema-v60.sql 2>/dev/null | head -15
```

确认：
- 字段 schema：`retry_counters JSONB NOT NULL DEFAULT '{}'::jsonb`
- 现有 keys：`spec_rounds` / `dev_completed_tasks`（按之前 Phase 1/2 用法）
- 新增 key 命名：`node_retry_counts: { [nodeId: string]: number }`

- [ ] **Step 1.2: 写失败测试**

Create `src/__tests__/unit/qi-retry-cap.test.ts`：

```typescript
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { resetTestDb } from '../helpers/db.js'
import {
  createRequirement,
  getRequirementById,
  incrementNodeRetryCount,
  getNodeRetryCount,
  NODE_RETRY_CAP,
} from '../../db/repositories/requirements.js'

describe('node retry cap helpers', () => {
  let reqId: number

  beforeAll(async () => {
    await resetTestDb()
  })

  beforeEach(async () => {
    const req = await createRequirement({
      title: 't', rawInput: 'x', gitlabProject: 'g/p',
      baseBranch: 'main', source: 'web', status: 'draft', createdBy: 'test',
    })
    reqId = req.id
  })

  it('returns 0 when node has no retry history', async () => {
    expect(await getNodeRetryCount(reqId, 'spec_author')).toBe(0)
  })

  it('increments per node independently', async () => {
    await incrementNodeRetryCount(reqId, 'spec_author')
    await incrementNodeRetryCount(reqId, 'spec_author')
    await incrementNodeRetryCount(reqId, 'plan_author')

    expect(await getNodeRetryCount(reqId, 'spec_author')).toBe(2)
    expect(await getNodeRetryCount(reqId, 'plan_author')).toBe(1)
    expect(await getNodeRetryCount(reqId, 'dev_author')).toBe(0)
  })

  it('preserves other retry_counters fields', async () => {
    // 模拟已有 spec_rounds 字段
    const req = await getRequirementById(reqId)
    expect(req).toBeDefined()
    // 先手动塞 spec_rounds
    const { getPool } = await import('../../db/pool.js')
    await getPool().query(
      `UPDATE requirements SET retry_counters = '{"spec_rounds": 5}'::jsonb WHERE id = $1`,
      [reqId],
    )

    await incrementNodeRetryCount(reqId, 'spec_author')

    const after = await getRequirementById(reqId)
    expect((after!.retryCounters as any).spec_rounds).toBe(5)
    expect((after!.retryCounters as any).node_retry_counts.spec_author).toBe(1)
  })

  it('exports NODE_RETRY_CAP constant', () => {
    expect(NODE_RETRY_CAP).toBeGreaterThan(0)
    expect(NODE_RETRY_CAP).toBeLessThanOrEqual(10)  // sanity
  })
})
```

- [ ] **Step 1.3: Run — expect FAIL**

```bash
npx vitest run src/__tests__/unit/qi-retry-cap.test.ts
```

- [ ] **Step 1.4: 实现 helpers**

修改 `src/db/repositories/requirements.ts`，在文件底部加：

```typescript
/** 单节点 retry 上限。超过后 retry endpoint 报错。 */
export const NODE_RETRY_CAP = 3

/**
 * Increment retry_counters.node_retry_counts[nodeId] atomically.
 * Sub-plan E.1：防无限 retry 失败节点。
 */
export async function incrementNodeRetryCount(
  requirementId: number,
  nodeId: string,
): Promise<void> {
  const pool = getPool()
  await pool.query(
    `UPDATE requirements
     SET retry_counters = jsonb_set(
       COALESCE(retry_counters, '{}'::jsonb),
       ARRAY['node_retry_counts', $2::text],
       COALESCE(
         (retry_counters #> ARRAY['node_retry_counts', $2::text])::int + 1,
         1
       )::text::jsonb,
       true
     ),
     updated_at = NOW()
     WHERE id = $1`,
    [requirementId, nodeId],
  )
}

/**
 * Read current retry count for a node (0 if never retried).
 */
export async function getNodeRetryCount(
  requirementId: number,
  nodeId: string,
): Promise<number> {
  const pool = getPool()
  const { rows } = await pool.query<{ count: number | null }>(
    `SELECT (retry_counters #> ARRAY['node_retry_counts', $2::text])::int AS count
     FROM requirements WHERE id = $1`,
    [requirementId, nodeId],
  )
  return rows[0]?.count ?? 0
}
```

注意：用 `#>` JSONB path 操作符 + `::int` cast 才能正确算 `+1`。

- [ ] **Step 1.5: Run — expect PASS**

```bash
npx vitest run src/__tests__/unit/qi-retry-cap.test.ts
```

- [ ] **Step 1.6: 修 retryFailedRun 加 cap check**

修改 `src/pipeline/graph-runner.ts:retryFailedRun`（Sub-plan E Task 1 实现）：

```typescript
import {
  getRequirementById,
  incrementNodeRetryCount,
  getNodeRetryCount,
  NODE_RETRY_CAP,
} from '../db/repositories/requirements.js'

export async function retryFailedRun(runId: number): Promise<void> {
  const run = await getTestRunById(runId)
  if (!run) {
    throw new Error(`retryFailedRun: run ${runId} not found`)
  }
  if (run.status !== 'failed') {
    throw new Error(
      `retryFailedRun: run ${runId} status is '${run.status}', expected 'failed'`,
    )
  }

  // Sub-plan E.1：cap check
  // 找最后一个 failed 的 stageResult 作为「这次 retry 的目标 node」
  const stageResults = run.stageResults ?? []
  const lastFailed = [...stageResults].reverse().find((s) => s.status === 'failed')
  if (lastFailed) {
    // 找 requirement
    const { getRequirementByPipelineRunId } = await import(
      '../db/repositories/requirements.js'
    )
    const req = await getRequirementByPipelineRunId(runId)
    if (req) {
      const count = await getNodeRetryCount(req.id, lastFailed.name)
      if (count >= NODE_RETRY_CAP) {
        throw new Error(
          `retryFailedRun: node '${lastFailed.name}' has been retried ${count} times (cap=${NODE_RETRY_CAP})`,
        )
      }
      await incrementNodeRetryCount(req.id, lastFailed.name)
    }
  }

  await updateTestRunStatus(runId, 'running')
  await resumeRun(runId, new Command({}))
}
```

注意：`getRequirementByPipelineRunId` 可能不存在，需先 grep。如不存在，先在 `requirements.ts` 加：

```typescript
export async function getRequirementByPipelineRunId(
  pipelineRunId: number,
): Promise<Requirement | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    `SELECT * FROM requirements WHERE pipeline_run_id = $1 LIMIT 1`,
    [pipelineRunId],
  )
  return rows[0] ? mapRow(rows[0]) : null
}
```

（`mapRow` 是该文件已有 helper，照其他 fn 用即可。）

- [ ] **Step 1.7: 扩展 retry cap 集成测试**

在 `src/__tests__/integration/qi-retry-admin.test.ts` 加新测试：

```typescript
it('rejects retry after NODE_RETRY_CAP exceeded', async () => {
  const { NODE_RETRY_CAP } = await import('../../db/repositories/requirements.js')
  // 模拟已 retry 3 次
  await app.pg.query(
    `UPDATE requirements SET retry_counters = $1::jsonb WHERE id = $2`,
    [JSON.stringify({ node_retry_counts: { 'spec_author': NODE_RETRY_CAP } }), requirementId],
  )
  // mock run.stageResults 含 spec_author failed
  await app.pg.query(
    `UPDATE test_runs SET stage_results = $1::jsonb, status='failed' WHERE id=$2`,
    [JSON.stringify([{ name: 'spec_author', status: 'failed', type: 'llm_author' }]), runId],
  )

  const resp = await app.inject({
    method: 'POST',
    url: `/admin/requirements/${requirementId}/retry`,
    payload: {},
  })
  expect(resp.statusCode).toBe(400)
  expect(JSON.parse(resp.body).error).toMatch(/retried \d+ times \(cap=\d+\)/i)
})
```

- [ ] **Step 1.8: Run + Commit**

```bash
./test.sh --typecheck
npx vitest run --exclude '**/var/**' src/__tests__/unit/qi-retry-cap src/__tests__/integration/qi-retry-admin
```

```bash
git add src/db/repositories/requirements.ts src/pipeline/graph-runner.ts src/__tests__/unit/qi-retry-cap.test.ts src/__tests__/integration/qi-retry-admin.test.ts
git commit -m "feat(qi): node retry cap — 单节点 retry 上限 3 次

Sub-plan E.1 Phase 1：防无限 retry 失败节点。
- requirements.retry_counters.node_retry_counts[nodeId]: number 计数
- NODE_RETRY_CAP=3 (单节点上限)
- retryFailedRun 入口校验：超 cap 时 throw 含错误信息（'retried N times (cap=3)'）
- admin endpoint 400 + 清晰错误返回前端

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 2: 节点列表 timeline UI（详情抽屉嵌入）

只读 timeline 展示每节点 status + 名称 + 耗时，**Phase 1 不加 retry-from-node 按钮**。

**Files:**
- Create: `web/src/components/StageResultsTimeline.tsx`
- Modify: `web/src/pages/RequirementsPage.tsx` — 详情抽屉嵌入 timeline

### Steps

- [ ] **Step 2.1: 探查现有详情抽屉结构**

```bash
grep -n "stage_results\|stageResults\|skillOutput\|V2StructuredView" web/src/pages/RequirementsPage.tsx | head -20
```

看现有详情抽屉怎么展示 stage_results（看是否已有 timeline 或 list，避免重复）。

- [ ] **Step 2.2: 写组件**

Create `web/src/components/StageResultsTimeline.tsx`：

```tsx
import React from 'react'
import { Timeline, Tag, Tooltip, Space, Typography } from 'antd'
import { CheckCircleOutlined, CloseCircleOutlined, SyncOutlined, ClockCircleOutlined, MinusCircleOutlined } from '@ant-design/icons'

type StageResult = {
  name: string  // node.id (e.g., 'spec_author')
  type: string
  status: 'pending' | 'running' | 'waiting' | 'success' | 'failed' | 'skipped'
  startedAt?: string
  finishedAt?: string
  durationMs?: number
  error?: string
}

type PipelineNode = {
  id?: string
  name?: string  // display name
  stageType?: string
}

const STATUS_META: Record<StageResult['status'], { color: string; icon: React.ReactNode }> = {
  pending: { color: 'default', icon: <ClockCircleOutlined /> },
  running: { color: 'processing', icon: <SyncOutlined spin /> },
  waiting: { color: 'warning', icon: <ClockCircleOutlined /> },
  success: { color: 'success', icon: <CheckCircleOutlined /> },
  failed: { color: 'error', icon: <CloseCircleOutlined /> },
  skipped: { color: 'default', icon: <MinusCircleOutlined /> },
}

function fmtDuration(ms?: number): string {
  if (!ms) return ''
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}

export function StageResultsTimeline({
  stageResults,
  pipelineNodes,
}: {
  stageResults: StageResult[]
  pipelineNodes?: PipelineNode[]
}) {
  const nodeNameMap = new Map<string, string>()
  for (const n of pipelineNodes ?? []) {
    if (n.id && n.name) nodeNameMap.set(n.id, n.name)
  }

  if (!stageResults.length) {
    return <Typography.Text type="secondary">还没有任何节点执行记录</Typography.Text>
  }

  return (
    <Timeline mode="left">
      {stageResults.map((sr, idx) => {
        const meta = STATUS_META[sr.status] ?? STATUS_META.pending
        const displayName = nodeNameMap.get(sr.name) ?? sr.name
        return (
          <Timeline.Item key={`${sr.name}-${idx}`} color={meta.color} dot={meta.icon}>
            <Space direction="vertical" size={2} style={{ width: '100%' }}>
              <Space>
                <Typography.Text strong>{displayName}</Typography.Text>
                <Tag color={meta.color}>{sr.status}</Tag>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {sr.type}
                </Typography.Text>
                {sr.durationMs ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    · {fmtDuration(sr.durationMs)}
                  </Typography.Text>
                ) : null}
              </Space>
              {sr.error ? (
                <Tooltip title={sr.error}>
                  <Typography.Text type="danger" style={{ fontSize: 12 }}>
                    {sr.error.slice(0, 120)}{sr.error.length > 120 ? '…' : ''}
                  </Typography.Text>
                </Tooltip>
              ) : null}
            </Space>
          </Timeline.Item>
        )
      })}
    </Timeline>
  )
}
```

- [ ] **Step 2.3: 嵌入详情抽屉**

修改 `web/src/pages/RequirementsPage.tsx`，在详情抽屉的合适位置（按 grep 看现有结构决定）加：

```tsx
import { StageResultsTimeline } from '../components/StageResultsTimeline'

// 在抽屉内：
<Divider orientation="left">节点执行记录</Divider>
<StageResultsTimeline
  stageResults={detail?.run?.stageResults ?? []}
  pipelineNodes={detail?.run?.pipelineGraph?.nodes ?? []}
/>
```

注：`detail.run.stageResults` 和 `detail.run.pipelineGraph.nodes` 的实际字段名以 API 响应为准。grep `getRequirement` / `getRequirementDetail` 的 admin endpoint 返回 schema。

如果详情 API 不返回 pipelineGraph，可以单独再 fetch：
```typescript
const pipelineGraph = await pipelinesApi.getById(detail.pipelineRunId).then(r => r.graph)
```

或更简单：直接传 stageResults，timeline 只显示 sr.name 不映射 displayName（后续优化）。

- [ ] **Step 2.4: 前端 typecheck**

```bash
cd web && pnpm exec tsc --noEmit
```

或：
```bash
./test.sh --typecheck
```

- [ ] **Step 2.5: Commit**

```bash
git add web/src/components/StageResultsTimeline.tsx web/src/pages/RequirementsPage.tsx
git commit -m "feat(qi/web): 详情抽屉嵌入节点列表 timeline（read-only）

Sub-plan E.1 Phase 1：展示每节点 status / 名称 / 类型 / 耗时 / error 摘要。
节点 displayName 从 pipeline.graph.nodes 映射（fallback 用 node.id）。
Phase 3 在此 timeline 加 retry-from-node 按钮。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Phase 2: Backend `retryFromNode` （experimental — LangGraph state mutation）

### Task 3: `retryFromNode(runId, fromNodeId)` 后端 helper

**Files:**
- Modify: `src/pipeline/graph-runner.ts` — 加 `retryFromNode` 函数
- Modify: `src/admin/routes/requirements.ts` — 加 `POST /requirements/:id/retry-from-node`
- Create: `src/__tests__/integration/qi-retry-from-node.test.ts`

### Steps

- [ ] **Step 3.1: 探查 LangGraph updateState + Command 用法**

```bash
grep -n "updateState\|compiled\.\|Command(" src/pipeline/graph-runner.ts | head -20
```

确认当前没有 updateState 用例，需要新引入。

- [ ] **Step 3.2: 写失败测试（先写测试明确预期行为）**

Create `src/__tests__/integration/qi-retry-from-node.test.ts`：

```typescript
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { resetTestDb } from '../helpers/db.js'
import { createTestRun, updateTestRunStatus, getTestRunById } from '../../db/repositories/test-runs.js'
import { createTestPipeline } from '../../db/repositories/test-pipelines.js'
import { createRequirement } from '../../db/repositories/requirements.js'

vi.mock('../../db/repositories/test-pipelines.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/repositories/test-pipelines.js')>()
  return {
    ...actual,
    // 让 reloadContext 早 return → resumeRun 静默退出
    // 这样测试只 verify DB 副作用 + cap check
    getTestPipelineById: vi.fn(async () => null),
  }
})

const grr = await import('../../pipeline/graph-runner.js')

describe('retryFromNode', () => {
  let pipelineId: number
  let runId: number
  let reqId: number

  beforeAll(async () => {
    await resetTestDb()
    const pipeline = await createTestPipeline({
      name: 'test-retry-fromnode',
      description: 'test',
      stages: [],
      graph: {
        nodes: [
          { id: 'spec_author', name: 'Spec Author', stageType: 'llm_author' },
          { id: 'spec_ai_review', name: 'Spec AI Review', stageType: 'llm_review' },
          { id: 'plan_author', name: 'Plan Author', stageType: 'llm_author' },
        ],
        edges: [],
      } as any,
      enabled: true,
      variables: {},
    })
    pipelineId = pipeline.id
  })

  beforeEach(async () => {
    const run = await createTestRun({
      pipelineId, triggerType: 'manual', triggeredBy: 'test',
      servers: {}, triggerParams: {}, runtimeVars: {},
    })
    runId = run.id

    // 模拟 plan_author 失败的 stage_results
    const { getPool } = await import('../../db/pool.js')
    await getPool().query(
      `UPDATE test_runs SET stage_results = $1::jsonb, status='failed' WHERE id = $2`,
      [JSON.stringify([
        { name: 'spec_author', status: 'success', type: 'llm_author', durationMs: 5000 },
        { name: 'spec_ai_review', status: 'success', type: 'llm_review', durationMs: 1000 },
        { name: 'plan_author', status: 'failed', type: 'llm_author', error: 'boom' },
      ]), runId],
    )

    const req = await createRequirement({
      title: 't', rawInput: 'x', gitlabProject: 'g/p',
      baseBranch: 'main', source: 'web', status: 'failed', createdBy: 'test',
    })
    await getPool().query(
      `UPDATE requirements SET pipeline_run_id = $1 WHERE id = $2`,
      [runId, req.id],
    )
    reqId = req.id
  })

  it('rejects when fromNodeId not found in pipeline graph', async () => {
    await expect(
      grr.retryFromNode(runId, 'nonexistent_node'),
    ).rejects.toThrow(/not found in pipeline graph/i)
  })

  it('rejects when run status is not failed', async () => {
    await updateTestRunStatus(runId, 'running')
    await expect(
      grr.retryFromNode(runId, 'spec_author'),
    ).rejects.toThrow(/expected 'failed'/i)
  })

  it('truncates stage_results back to fromNode and resets status', async () => {
    await grr.retryFromNode(runId, 'spec_ai_review')

    const after = await getTestRunById(runId)
    expect(after?.status).toBe('running')
    // stage_results 截断：保留 spec_author + spec_ai_review，删 plan_author
    const names = (after?.stageResults ?? []).map((s) => s.name)
    expect(names).toEqual(['spec_author', 'spec_ai_review'])
  })

  it('rejects when node retry cap exceeded', async () => {
    const { NODE_RETRY_CAP } = await import('../../db/repositories/requirements.js')
    const { getPool } = await import('../../db/pool.js')
    await getPool().query(
      `UPDATE requirements SET retry_counters = $1::jsonb WHERE id = $2`,
      [JSON.stringify({ node_retry_counts: { spec_ai_review: NODE_RETRY_CAP } }), reqId],
    )

    await expect(
      grr.retryFromNode(runId, 'spec_ai_review'),
    ).rejects.toThrow(/retried \d+ times \(cap=\d+\)/i)
  })

  it('increments retry count for fromNode', async () => {
    await grr.retryFromNode(runId, 'spec_ai_review')

    const { getNodeRetryCount } = await import('../../db/repositories/requirements.js')
    expect(await getNodeRetryCount(reqId, 'spec_ai_review')).toBe(1)
  })
})
```

- [ ] **Step 3.3: Run — expect FAIL**

```bash
npx vitest run src/__tests__/integration/qi-retry-from-node.test.ts
```

- [ ] **Step 3.4: 实现 retryFromNode**

修改 `src/pipeline/graph-runner.ts`，在 `retryFailedRun` 之后添加：

```typescript
import { getTestPipelineById } from '../db/repositories/test-pipelines.js'
import { getPool } from '../db/pool.js'

/**
 * Retry pipeline run from an arbitrary node (rewind state).
 *
 * Sub-plan E.1 §Phase 2 'invalidate_downstream' 模式：
 * 1. 校验 fromNodeId 在 pipeline.graph.nodes 中
 * 2. 校验 retry cap
 * 3. 截断 test_runs.stage_results 数组（保留 ≤ fromNodeId 的 entries）
 * 4. 重置 test_runs.status='running' + increment retry count
 * 5. resumeRun 让 LangGraph reducer merge 新结果（mergeStageResults 按 name 去重，
 *    fromNode 之后重跑的 entries 会覆盖旧 success 记录）
 *
 * 已知 LangGraph 行为限制：
 * - 当前实现**不** mutate LangGraph checkpoint 内部 state（即 channel_values 不直接改写）
 * - 依赖 graph 重 stream 时 reducer 自然合并新输出
 * - 如果 graph 不从 fromNode 真正重启（LangGraph 认为已 done），需要后续用
 *   compiled.updateState({}, asNode: fromNode) 强制定位
 * - 见 plan §Risks
 */
export async function retryFromNode(
  runId: number,
  fromNodeId: string,
): Promise<void> {
  const run = await getTestRunById(runId)
  if (!run) {
    throw new Error(`retryFromNode: run ${runId} not found`)
  }
  if (run.status !== 'failed') {
    throw new Error(
      `retryFromNode: run ${runId} status is '${run.status}', expected 'failed'`,
    )
  }

  // 校验 fromNodeId 在 pipeline graph 中
  const pipeline = await getTestPipelineById(run.pipelineId)
  if (!pipeline) {
    throw new Error(`retryFromNode: pipeline ${run.pipelineId} not found`)
  }
  const nodes = (pipeline.graph as any)?.nodes ?? []
  const nodeExists = nodes.some((n: any) => n.id === fromNodeId)
  if (!nodeExists) {
    throw new Error(
      `retryFromNode: fromNodeId '${fromNodeId}' not found in pipeline graph`,
    )
  }

  // 找 requirement 做 cap check
  const { getRequirementByPipelineRunId } = await import(
    '../db/repositories/requirements.js'
  )
  const req = await getRequirementByPipelineRunId(runId)
  if (req) {
    const count = await getNodeRetryCount(req.id, fromNodeId)
    if (count >= NODE_RETRY_CAP) {
      throw new Error(
        `retryFromNode: node '${fromNodeId}' has been retried ${count} times (cap=${NODE_RETRY_CAP})`,
      )
    }
    await incrementNodeRetryCount(req.id, fromNodeId)
  }

  // 截断 stage_results：保留 ≤ fromNode 的 entries
  const currentResults = run.stageResults ?? []
  const fromIdx = currentResults.findIndex((s) => s.name === fromNodeId)
  if (fromIdx < 0) {
    // fromNode 还没在 stage_results 里出现，整条截掉（从头开始）
    await getPool().query(
      `UPDATE test_runs SET stage_results='[]'::jsonb WHERE id = $1`,
      [runId],
    )
  } else {
    // 保留 [0, fromIdx]（含 fromNode 自身那条 — 让它被新结果覆盖）
    const truncated = currentResults.slice(0, fromIdx)
    await getPool().query(
      `UPDATE test_runs SET stage_results = $1::jsonb WHERE id = $2`,
      [JSON.stringify(truncated), runId],
    )
  }

  await updateTestRunStatus(runId, 'running')
  await resumeRun(runId, new Command({}))
}
```

注意：
- 直接用 raw SQL 改 stage_results（绕过 mergeStageResults 合并），是**显式 set**操作
- `fromIdx < 0` 时全清（异常情况兜底）
- `fromIdx >= 0` 时保留 `[0, fromIdx)`（不含 fromNode 那条，让 LangGraph 重 run 产新 entry）

- [ ] **Step 3.5: 加 admin endpoint**

修改 `src/admin/routes/requirements.ts`，在 `POST /retry` 之后插入：

```typescript
  // POST /requirements/:id/retry-from-node — Sub-plan E.1 Phase 2 invalidate_downstream
  app.post<{
    Params: { id: string }
    Body: { fromNodeId: string }
  }>('/requirements/:id/retry-from-node', async (req, reply) => {
    const id = Number(req.params.id)
    if (isNaN(id)) return reply.status(400).send({ error: 'invalid id' })

    const fromNodeId = String(req.body?.fromNodeId ?? '').trim()
    if (!fromNodeId) {
      return reply.status(400).send({ error: 'fromNodeId is required in body' })
    }

    const requirement = await getRequirementById(id)
    if (!requirement) return reply.status(404).send({ error: 'requirement not found' })

    if (!requirement.pipelineRunId) {
      return reply.status(400).send({
        error: 'requirement has no pipelineRunId; cannot retry-from-node',
      })
    }

    try {
      await retryFromNode(requirement.pipelineRunId, fromNodeId)
      return { ok: true, retriedFromNode: fromNodeId }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return reply.status(400).send({ error: msg })
    }
  })
```

并在 imports 加：
```typescript
import { retryFailedRun, retryFromNode } from '../../pipeline/graph-runner.js'
```

- [ ] **Step 3.6: 加 admin route 集成测试到 qi-retry-from-node.test.ts**

继续 `qi-retry-from-node.test.ts`，加 admin route describe：

```typescript
describe('POST /requirements/:id/retry-from-node', () => {
  let app: any

  beforeAll(async () => {
    const { buildAdminTestApp } = await import('../helpers/admin-test-app.js')  // 实际 helper 名 grep 确认
    app = await buildAdminTestApp()
  })

  it('returns 400 when fromNodeId missing', async () => {
    const resp = await app.inject({
      method: 'POST',
      url: `/admin/requirements/${reqId}/retry-from-node`,
      payload: {},
    })
    expect(resp.statusCode).toBe(400)
    expect(JSON.parse(resp.body).error).toMatch(/fromNodeId is required/i)
  })

  it('returns 200 + retriedFromNode on success', async () => {
    await updateTestRunStatus(runId, 'failed')

    const resp = await app.inject({
      method: 'POST',
      url: `/admin/requirements/${reqId}/retry-from-node`,
      payload: { fromNodeId: 'spec_ai_review' },
    })
    expect(resp.statusCode).toBe(200)
    expect(JSON.parse(resp.body)).toMatchObject({
      ok: true,
      retriedFromNode: 'spec_ai_review',
    })
  })

  it('returns 400 with node-not-in-graph error', async () => {
    const resp = await app.inject({
      method: 'POST',
      url: `/admin/requirements/${reqId}/retry-from-node`,
      payload: { fromNodeId: 'fake_node_xyz' },
    })
    expect(resp.statusCode).toBe(400)
    expect(JSON.parse(resp.body).error).toMatch(/not found in pipeline graph/i)
  })
})
```

- [ ] **Step 3.7: Run + Commit**

```bash
./test.sh --typecheck
npx vitest run --exclude '**/var/**' src/__tests__/integration/qi-retry-from-node
```

```bash
git add src/pipeline/graph-runner.ts src/admin/routes/requirements.ts src/__tests__/integration/qi-retry-from-node.test.ts
git commit -m "feat(qi): retryFromNode 后端 + admin endpoint — experimental invalidate_downstream

Sub-plan E.1 Phase 2 'invalidate_downstream' 模式：
- retryFromNode(runId, fromNodeId): 校验节点存在 + cap → 截断 stage_results → 重置 status → resumeRun
- POST /admin/requirements/:id/retry-from-node + body { fromNodeId }
- 已知限制：不 mutate LangGraph checkpoint 内部 state，依赖 reducer 合并新结果；
  如 graph 不从 fromNode 真重启需手动 smoke verify（plan §Risks）

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Phase 3: 前端节点级 retry 按钮

### Task 4: 前端 retry-from-node 按钮（嵌入 timeline）

每个 timeline 节点旁显示「重试此节点」按钮。failed 状态的节点可点；success 状态的节点可点（用户主动回退）；cap 已达的节点 disabled。

**Files:**
- Modify: `web/src/api/requirements.ts` — 加 `retryFromNode(id, fromNodeId)`
- Modify: `web/src/components/StageResultsTimeline.tsx` — 加可选 onRetry prop + 按钮
- Modify: `web/src/pages/RequirementsPage.tsx` — 传 onRetry 接 API

### Steps

- [ ] **Step 4.1: API client 方法**

修改 `web/src/api/requirements.ts`，在 `retry` 方法附近加：

```typescript
async retryFromNode(id: number, fromNodeId: string): Promise<{ ok: boolean; retriedFromNode: string }> {
  const { data } = await client.post(`/admin/requirements/${id}/retry-from-node`, { fromNodeId })
  return data
},
```

（参考 retry 的 axios client 模式，保持一致）

- [ ] **Step 4.2: timeline 组件加按钮**

修改 `web/src/components/StageResultsTimeline.tsx`，在 props 加 `onRetry?: (nodeId: string) => void`，在 Timeline.Item 内加按钮：

```tsx
import { Button, Popconfirm } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'

// props 加
onRetry?: (nodeId: string) => Promise<void>
isRetryDisabled?: (nodeId: string) => boolean  // cap check

// Timeline.Item 内末尾加
{onRetry && (sr.status === 'failed' || sr.status === 'success') && (
  <Popconfirm
    title={`确定从「${displayName}」节点重试？`}
    description="将截断该节点之后的所有结果，从此节点重新执行。"
    onConfirm={() => onRetry(sr.name)}
    okText="重试"
    cancelText="取消"
    disabled={isRetryDisabled?.(sr.name)}
  >
    <Button
      size="small"
      icon={<ReloadOutlined />}
      disabled={isRetryDisabled?.(sr.name)}
      title={isRetryDisabled?.(sr.name) ? '已达 retry 上限' : ''}
    >
      重试此节点
    </Button>
  </Popconfirm>
)}
```

- [ ] **Step 4.3: RequirementsPage 传 onRetry**

修改 `web/src/pages/RequirementsPage.tsx`，详情抽屉里：

```tsx
<StageResultsTimeline
  stageResults={detail?.run?.stageResults ?? []}
  pipelineNodes={detail?.run?.pipelineGraph?.nodes ?? []}
  onRetry={detail?.status === 'failed' ? async (nodeId) => {
    try {
      await requirementsApi.retryFromNode(detail.id, nodeId)
      message.success(`已从节点「${nodeId}」重试`)
      await loadDetail(detail.id)
    } catch (err: any) {
      message.error(`重试失败：${err?.response?.data?.error ?? err.message}`)
    }
  } : undefined}
/>
```

注意：只在 `detail?.status === 'failed'` 时传 onRetry（其他状态下不显示按钮，timeline read-only）。

cap check 暂不传 isRetryDisabled（前端没办法预知 cap 是否到 — 让后端报错处理即可；显示 disabled 是 UX 优化，留 follow-up）。

- [ ] **Step 4.4: 前端 typecheck**

```bash
./test.sh --typecheck
```

- [ ] **Step 4.5: Commit**

```bash
git add web/src/api/requirements.ts web/src/components/StageResultsTimeline.tsx web/src/pages/RequirementsPage.tsx
git commit -m "feat(qi/web): timeline 每节点加「重试此节点」按钮

Sub-plan E.1 Phase 3：
- API client 加 retryFromNode(id, fromNodeId)
- StageResultsTimeline 加 onRetry prop + Popconfirm 按钮（failed/success 节点可点）
- 仅 requirement.status='failed' 时启用（避免 running 中误触）
- cap 超限错误 ux：依赖后端 400 返回 + message.error 提示（前端 disabled 留 follow-up）

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Phase 4: 全套测试 + smoke verify

### Task 5: full verify

无新代码，仅 verify。

### Steps

- [ ] **Step 5.1: Typecheck**

```bash
./test.sh --typecheck
```

- [ ] **Step 5.2: 相关测试套件**

```bash
npx vitest run --exclude '**/var/**' \
  src/__tests__/unit/qi-retry-cap \
  src/__tests__/integration/qi-retry-admin \
  src/__tests__/integration/qi-retry-from-node \
  src/__tests__/integration/qi-pipeline-bootstrap-v12 \
  src/__tests__/integration/qi-pipeline-bootstrap-v13 \
  src/__tests__/unit/node-types/init-qi-branch-push \
  src/__tests__/unit/node-types/mr-create-idempotent \
  src/__tests__/unit/node-types/cleanup-gitlab
```

Expected: 全 PASS。

- [ ] **Step 5.3: 可选 — 完整测试**

```bash
./test.sh
```

Expected: 仅 pre-existing failures。Sub-plan E.1 不应引入新 failures。

- [ ] **Step 5.4: 手动 smoke（强烈建议，验证 LangGraph 行为）**

```bash
# 后端起 + 前端起
# 浏览器：找之前 manual test 的 failed requirement
# 1. 进详情抽屉，看 timeline 显示所有节点 + status ✅
# 2. 点 "Spec AI Review" 节点的「重试此节点」 → 后端 truncate stage_results 后 →
#    刷新看 spec_ai_review 之后的 stage_results 消失 + status='running' ✅
# 3. 等几秒看 graph 是否真从 spec_ai_review 重 run → stage_results 新增 spec_ai_review 新结果
#    ⚠️ 如果 graph 不真 re-run，这是 plan §Risks 提到的 LangGraph 行为限制，
#    需要补 compiled.updateState({}, asNode: prevNode) 强制定位
```

如手动 smoke 发现 graph 不真重启，BLOCKED 报告 → 下个 patch 补 updateState 调用。

- [ ] **Step 5.5: 不需要 commit**（仅 verify）

---

## Self-Review

- [ ] **Spec coverage**：
  - spec §5.5 'invalidate_downstream 模式' → Phase 2 Task 3 ✅（best-effort 实现，可能需后续补 updateState）
  - spec 推迟到 Sub-plan E.1 的 3 个 follow-up（节点级 UI / retry 上限 / arbitrary fromNode）全覆盖 ✅

- [ ] **Placeholder scan**：grep `TODO|TBD` 在 plan 代码块。无（已知限制写在「Phase 2 注释」+ §Risks）。

- [ ] **Type consistency**：
  - `incrementNodeRetryCount(reqId, nodeId)` / `getNodeRetryCount(reqId, nodeId)` signature 一致 ✅
  - `retryFromNode(runId, fromNodeId)` / API `retryFromNode(id, fromNodeId)` 命名前后一致 ✅
  - `NODE_RETRY_CAP=3` 常量统一引用 ✅
  - stage_results truncate 用 raw SQL（绕 mergeStageResults reducer）— 直接 set 数组 ✅

- [ ] **跨 sub-plan 兼容**：
  - Sub-plan E retryFailedRun 加 cap check（向后兼容，旧 requirement retry_counters 为空时 count=0）
  - 不改 LangGraph state — 与 Sub-plan A/B/C/D 节点行为无关
  - Phase 2 backend 即使 LangGraph 没真 rerun，DB 截断 + status='running' 是 visible 改动

---

## 已知风险（plan §Risks）

1. **LangGraph 真重启行为未 verify**：retryFromNode 当前只截断 DB stage_results + resumeRun，**不** mutate LangGraph checkpoint internal state。如果 LangGraph 认为图已完成不真重启，需要后续补 `compiled.updateState({}, asNode: prevNode)` 强制定位。Task 5 §5.4 要求手动 smoke 验证。
2. **mergeStageResults reducer 合并语义**：截断后 LangGraph stream 新输出时，reducer 按 name 去重 merge。理论上重 run 的 fromNode 产新结果会覆盖（因 name 相同）。但如果 graph 不真 rerun fromNode，merge 仅是 no-op。
3. **跨 retry 累计 cap**：用户 retry 同一节点 3 次后再也不能 retry。要重置 cap 需手动 SQL `UPDATE requirements SET retry_counters = retry_counters - 'node_retry_counts'` — 暂不提供 admin UI 重置入口（YAGNI，follow-up）

---

## Execution Handoff

Plan 写完，保存到 `docs/superpowers/plans/2026-05-11-qi-pipeline-retry-advanced-sub-plan-e1.md`。

**风险：**
- Phase 2 LangGraph 行为是核心未知。如果手动 smoke 显示 graph 不真重启 fromNode，Phase 2/3 价值大打折扣（要补 updateState 调用，复杂度上一档）
- Phase 1（retry cap + read-only timeline）独立可上线，即使 Phase 2 BLOCKED 也有价值

**执行选项：**

1. **Subagent-Driven（推荐）** — 每 task fresh subagent + 两阶段 review
2. **Inline 执行** — 当前 session 用 executing-plans skill 批量跑

Which approach?
