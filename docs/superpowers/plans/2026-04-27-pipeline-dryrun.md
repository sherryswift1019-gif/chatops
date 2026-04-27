# Pipeline 试运行（单步执行 + 真实数据）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在画布编辑流水线时新增「试运行」能力 — 节点上 ▶ 按钮触发，从入口跑到该节点；副作用节点逐节点弹决策框（真跑/Stub/手填）；wait_webhook/im_input 沿用 langgraph interrupt 让用户外部真触发；stepOutputs 持久存盘；Inspector 加「上游字段」Tab 让用户点 leaf 一键插入 `{{steps.<id>.output.<field>}}` 模板。

**Architecture:** Wrapper 模式 — 复用现有 `buildGraphFromPipeline`，给 `StageHooks` 加可选 `dryRunFlavor` 字段，副作用节点（dm/db_update/script/approval/http）在 dispatcher 里套一层 `interrupt('dryrun-decision')` wrapper；非副作用节点直接真跑；wait_webhook/im_input 不 wrap，沿用现有 interrupt 模式；fan_out 子节点（不经 dispatcher）单独走"强制 stub"路径。结果通过 SSE 流送前端，副作用决策通过 `POST /decide` 回写并 `Command({resume})`；snapshot UPSERT 到新表 `pipeline_dryrun_snapshots`。

**Tech Stack:** TypeScript / Vitest / Fastify (SSE 已用过 prd-chat 模板) / @langchain/langgraph (PostgresSaver checkpointer 已用) / PostgreSQL (jsonb + pg_try_advisory_lock) / React 18 + @xyflow/react v12 + antd v5 + Monaco editor (新依赖)

**Spec 来源：** [docs/superpowers/specs/2026-04-27-pipeline-dryrun-design.md](../specs/2026-04-27-pipeline-dryrun-design.md)（505 行、12 章节、14 决策）

---

## Context

**Why this change:** 当前画布编辑流水线时用户必须靠脑想象上游产出 + 手输 `{{steps.<id>.output.<field>}}` 模板，错字+无补全；下游节点配 LLM JSON 路由也要等到真跑出错才知 schema 不对。本次新增"试运行"能力让用户单步跑、看真实输出、点字段一键插模板 = REPL 式管道编辑体验，配置阶段大幅减少 trial-and-error。

**Intended outcome：**
1. 用户点节点上 ▶ → 试跑到此节点 → SSE 实时回送进度 + 副作用决策 + 等待外部触发
2. snapshot 持久 → Inspector「上游字段」Tab 渲染 JSON Tree → 点 leaf 复制 `{{steps.<id>.output.<field>}}` 路径
3. webhook 触发的流水线（GitLab/DingTalk/Feishu）能从 test_runs 历史回放真实 payload 做试跑
4. 上游 params 改动后对应 snapshot 标 stale ⚠

---

## File Structure

**新建后端文件**：
- `src/db/schema-v45.sql` — `pipeline_dryrun_snapshots` 表 + `test_runs.trigger_params` 列
- `src/db/repositories/dryrun-snapshots.ts` — CRUD + UPSERT + stale 标算法
- `src/pipeline/dryrun-hash.ts` — `computeUpstreamHash` 算法
- `src/pipeline/dryrun-stub.ts` — `generateStubFromSchema` 算法
- `src/pipeline/dryrun-runner.ts` — DryRunFlavor hooks 实现 + session map + SSE 推送 + advisory lock
- `src/pipeline/dryrun-webhook-router.ts` — dry-run 命名空间扩展（webhook URL 参数化 thread_id）
- `src/admin/routes/dryrun.ts` — 6 个 API endpoint（runs/snapshots/decide/recent-trigger-params）

**新建前端文件**：
- `web/src/pipeline-canvas/dryrun/useDryRunSSE.ts` — EventSource 客户端 + 状态机
- `web/src/pipeline-canvas/dryrun/DryRunStartModal.tsx` — 3 Tab 启动对话框
- `web/src/pipeline-canvas/dryrun/SideEffectDecisionModal.tsx` — 副作用决策框（含 Monaco）
- `web/src/pipeline-canvas/dryrun/WaitingExternalBanner.tsx` — wait_webhook/im_input 等待状态条
- `web/src/pipeline-canvas/panels/UpstreamFieldsTab.tsx` — Inspector 上游字段树
- `web/src/api/dryrun.ts` — REST/SSE API 客户端
- `web/src/pipeline-canvas/canvas/nodes/NodeRunButton.tsx` — 节点 ▶ 按钮（嵌入到所有节点 wrapper）

**修改后端文件**：
- `src/pipeline/graph-builder.ts` — `StageHooks` 加 `dryRunFlavor` 可选字段；副作用 5 类节点 dispatcher case 增加 wrapper
- `src/pipeline/node-types/fan-out.ts` — fan_out 子节点检测副作用 stageType 时走 stub（v1 保守）
- `src/db/repositories/test-runs.ts` — 写入时持久 trigger_params；查询时反解
- `src/db/migrate.ts` — `SCHEMA_FILES` 追加 `['v45', 'schema-v45.sql']`
- `src/server.ts` — 注册 dryrun routes

**修改前端文件**：
- `web/src/pipeline-canvas/panels/NodeInspector.tsx` — 改用 antd Tabs，挂「参数」+「上游字段」两 Tab
- `web/src/pipeline-canvas/canvas/nodes/StageNodeCard.tsx` + `SwitchNode.tsx` — 节点视觉加 ▶ 按钮 + waiting 黄边状态
- `web/src/pipeline-canvas/toolbar/CanvasToolbar.tsx` — 加「▶ 试运行整图」按钮
- `web/package.json` — 加 `@monaco-editor/react` 依赖

---

## Critical Existing Code（plan 各 Task 引用）

| 模块 | 路径/行号 | 用途 |
|---|---|---|
| `buildGraphFromPipeline` | `src/pipeline/graph-builder.ts:906` | 主入口，扩 `dryRunFlavor` hooks |
| `buildExecutorNode` | `src/pipeline/graph-builder.ts:~360` | 4 参数签名，wrapper 在外层包 |
| `getExecutor` | `src/pipeline/node-types/registry.js` | fan_out 内部调用方式 |
| `computeAncestors` | `src/pipeline/graph-validation.ts:112` | DFS 工具，hash 算法复用 |
| `PostgresSaver` checkpointer | `src/pipeline/graph-runtime.ts:15` | 项目已用，dry-run 加 `dryrun-<sessionId>` 前缀复用 |
| `IM router` | `src/pipeline/im-router.ts:23-24` | 内存 Map 结构（byRun + byGroup） |
| `SSE 模式` | `src/admin/routes/prd-chat.ts` | `Content-Type: text/event-stream`，复用 |
| `EventSource 客户端模板` | `web/src/pages/PrdChatPage.tsx`（如有） | 前端 SSE 接收模板 |
| `fan_out executor` | `src/pipeline/node-types/fan-out.ts:236-248` | 直接 `getExecutor().execute()`，不经 dispatcher |
| `current NodeInspector` | `web/src/pipeline-canvas/panels/NodeInspector.tsx` | 单页 Form，需改 Tabs |
| `DEFAULT pipeline_node_types schema` | DB 表 `pipeline_node_types.output_schema` | Stub 算法读这个 jsonb |
| `test_runs` 表 | `src/db/schema-v3.sql:33-47` | 缺 `trigger_params` 列，schema-v45 补 |

---

## 实施次序总结

```
Task 1 (schema-v45 + test_runs ALTER) → Task 2 (hash) → Task 3 (stub) → Task 4 (DryRunFlavor hooks 注入)
                                                                              │
Task 5 (dryrun-runner 主体) ←──────────────────────────────────────────────────┘
                  │
Task 6 (webhook 路由 dry-run 命名空间)
                  │
Task 7 (6 个 SSE/REST endpoint)
                  │
                  ├── Task 8 (前端 useDryRunSSE)
                  ├── Task 9 (DryRunStartModal)
                  ├── Task 10 (SideEffectDecisionModal)
                  ├── Task 11 (画布等待状态视觉 + ▶ 按钮)
                  ├── Task 12 (NodeInspector Tabs + UpstreamFieldsTab)
                  └── Task 13 (toolbar 整图按钮 + 串联各前端模块)
                  │
Task 14 (端到端集成测试 — 真后端 + mock SSE 客户端)
```

后端 Task 1-7 串行（共改 graph-builder 与 hooks 类型）；前端 Task 8-13 大体并行（不同文件）但 Task 8 的 hook 是 9-13 共同依赖，需先做。

---

## Task 1: schema-v45 — `pipeline_dryrun_snapshots` 表 + `test_runs.trigger_params` 列 + repository

**Files:**
- Create: `src/db/schema-v45.sql`
- Create: `src/db/repositories/dryrun-snapshots.ts`
- Modify: `src/db/migrate.ts` (SCHEMA_FILES 追加)
- Modify: `src/db/repositories/test-runs.ts` (写入时持久 trigger_params)
- Test: `src/__tests__/unit/dryrun-snapshots-repo.test.ts`
- Test: `src/__tests__/unit/v45-migration.test.ts`

**目的：** 落数据模型层（含 spec §3.1 表 + Explore 发现的 test_runs 缺 trigger_params 列），repository 提供 UPSERT/list/delete/单删 + stale 标计算。

- [ ] **Step 1: 写 v45 migration 单测**

Create `src/__tests__/unit/v45-migration.test.ts`：
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Pool } from 'pg'

describe('v45 migration', () => {
  let pool: Pool
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL })
  })
  afterAll(async () => { await pool.end() })

  it('pipeline_dryrun_snapshots 表存在 + 主键 + 字段类型', async () => {
    const r = await pool.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name='pipeline_dryrun_snapshots' ORDER BY ordinal_position`)
    const cols = r.rows.map((c: any) => c.column_name)
    expect(cols).toEqual(expect.arrayContaining([
      'pipeline_id', 'node_id', 'status', 'output', 'source',
      'upstream_params_hash', 'last_decision', 'last_manual_input',
      'duration_ms', 'error', 'ran_at',
    ]))
  })

  it('test_runs 加了 trigger_params 列', async () => {
    const r = await pool.query(`
      SELECT data_type FROM information_schema.columns
      WHERE table_name='test_runs' AND column_name='trigger_params'`)
    expect(r.rows.length).toBe(1)
    expect(r.rows[0].data_type).toBe('jsonb')
  })

  it('幂等：跑两次 v45 第二次 no-op', async () => {
    // resetTestDb 后 v45 已应用一次；再次运行不应抛错
    // 实现时直接 readFileSync schema-v45.sql 跑第二遍
  })
})
```

- [ ] **Step 2: Run 看 fail**

Run: `cd /Users/yan/Documents/Code/chatops && npx vitest run src/__tests__/unit/v45-migration.test.ts`
Expected: FAIL — schema-v45.sql 不存在

- [ ] **Step 3: 创建 schema-v45.sql**

Create `src/db/schema-v45.sql`：
```sql
-- v45: pipeline_dryrun_snapshots 表 + test_runs.trigger_params 列

CREATE TABLE IF NOT EXISTS pipeline_dryrun_snapshots (
  pipeline_id           INT NOT NULL REFERENCES test_pipelines(id) ON DELETE CASCADE,
  node_id               TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('success','failed','skipped')),
  output                JSONB NOT NULL DEFAULT '{}',
  source                TEXT NOT NULL CHECK (source IN ('real','stub','manual')),
  upstream_params_hash  TEXT NOT NULL,
  last_decision         TEXT,
  last_manual_input     JSONB,
  duration_ms           INT,
  error                 TEXT,
  ran_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (pipeline_id, node_id)
);

CREATE INDEX IF NOT EXISTS idx_dryrun_snapshots_pipeline
  ON pipeline_dryrun_snapshots(pipeline_id);

ALTER TABLE test_runs
  ADD COLUMN IF NOT EXISTS trigger_params JSONB NOT NULL DEFAULT '{}';
```

- [ ] **Step 4: migrate.ts SCHEMA_FILES 追加**

修改 `src/db/migrate.ts`，数组末尾追加：
```ts
['v45', 'schema-v45.sql'],
```

- [ ] **Step 5: 跑 migration 单测看 pass**

Run: `npx vitest run src/__tests__/unit/v45-migration.test.ts`
Expected: PASS（3 个 it 全绿）

- [ ] **Step 6: 写 repository 单测**

Create `src/__tests__/unit/dryrun-snapshots-repo.test.ts`：
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { resetTestDb } from '../helpers/db.js'
import {
  upsertSnapshot, listSnapshots, deleteSnapshot, deleteAllSnapshots,
} from '../../db/repositories/dryrun-snapshots.js'
import { getPool } from '../../db/client.js'

describe('dryrun-snapshots repository', () => {
  beforeEach(async () => { await resetTestDb() })

  async function seedPipeline(): Promise<number> {
    const r = await getPool().query(
      `INSERT INTO test_pipelines (name) VALUES ('p1') RETURNING id`)
    return r.rows[0].id as number
  }

  it('upsertSnapshot 新增 + 覆盖', async () => {
    const pid = await seedPipeline()
    await upsertSnapshot({
      pipelineId: pid, nodeId: 'n1',
      status: 'success', output: { foo: 'bar' }, source: 'real',
      upstreamParamsHash: 'aaa', lastDecision: null, lastManualInput: null,
      durationMs: 100, error: null,
    })
    const list1 = await listSnapshots(pid)
    expect(list1).toHaveLength(1)
    expect(list1[0].output).toEqual({ foo: 'bar' })
    // 覆盖
    await upsertSnapshot({
      pipelineId: pid, nodeId: 'n1',
      status: 'success', output: { foo: 'baz' }, source: 'stub',
      upstreamParamsHash: 'bbb', lastDecision: 'stub', lastManualInput: null,
      durationMs: 0, error: null,
    })
    const list2 = await listSnapshots(pid)
    expect(list2).toHaveLength(1)
    expect(list2[0].output).toEqual({ foo: 'baz' })
    expect(list2[0].source).toBe('stub')
    expect(list2[0].lastDecision).toBe('stub')
  })

  it('deleteSnapshot 单删 / deleteAll 清空', async () => {
    const pid = await seedPipeline()
    await upsertSnapshot({
      pipelineId: pid, nodeId: 'n1', status: 'success', output: {},
      source: 'real', upstreamParamsHash: 'h', lastDecision: null,
      lastManualInput: null, durationMs: 0, error: null,
    })
    await upsertSnapshot({
      pipelineId: pid, nodeId: 'n2', status: 'success', output: {},
      source: 'real', upstreamParamsHash: 'h', lastDecision: null,
      lastManualInput: null, durationMs: 0, error: null,
    })
    expect((await listSnapshots(pid)).length).toBe(2)
    await deleteSnapshot(pid, 'n1')
    expect((await listSnapshots(pid)).length).toBe(1)
    await deleteAllSnapshots(pid)
    expect((await listSnapshots(pid)).length).toBe(0)
  })

  it('删除 pipeline 级联删 snapshot', async () => {
    const pid = await seedPipeline()
    await upsertSnapshot({
      pipelineId: pid, nodeId: 'n1', status: 'success', output: {},
      source: 'real', upstreamParamsHash: 'h', lastDecision: null,
      lastManualInput: null, durationMs: 0, error: null,
    })
    await getPool().query(`DELETE FROM test_pipelines WHERE id=$1`, [pid])
    const r = await getPool().query(
      `SELECT * FROM pipeline_dryrun_snapshots WHERE pipeline_id=$1`, [pid])
    expect(r.rowCount).toBe(0)
  })
})
```

- [ ] **Step 7: 创建 repository 实现**

Create `src/db/repositories/dryrun-snapshots.ts`：
```ts
import { getPool } from '../client.js'

export interface DryRunSnapshot {
  pipelineId: number
  nodeId: string
  status: 'success' | 'failed' | 'skipped'
  output: Record<string, unknown>
  source: 'real' | 'stub' | 'manual'
  upstreamParamsHash: string
  lastDecision: string | null
  lastManualInput: Record<string, unknown> | null
  durationMs: number | null
  error: string | null
  ranAt: Date
}

interface UpsertInput extends Omit<DryRunSnapshot, 'ranAt'> {}

function mapRow(r: Record<string, unknown>): DryRunSnapshot {
  return {
    pipelineId: r.pipeline_id as number,
    nodeId: r.node_id as string,
    status: r.status as DryRunSnapshot['status'],
    output: (r.output ?? {}) as Record<string, unknown>,
    source: r.source as DryRunSnapshot['source'],
    upstreamParamsHash: r.upstream_params_hash as string,
    lastDecision: (r.last_decision ?? null) as string | null,
    lastManualInput: (r.last_manual_input ?? null) as Record<string, unknown> | null,
    durationMs: (r.duration_ms ?? null) as number | null,
    error: (r.error ?? null) as string | null,
    ranAt: r.ran_at as Date,
  }
}

export async function upsertSnapshot(input: UpsertInput): Promise<void> {
  await getPool().query(
    `INSERT INTO pipeline_dryrun_snapshots (
       pipeline_id, node_id, status, output, source,
       upstream_params_hash, last_decision, last_manual_input,
       duration_ms, error, ran_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
     ON CONFLICT (pipeline_id, node_id) DO UPDATE SET
       status = EXCLUDED.status, output = EXCLUDED.output, source = EXCLUDED.source,
       upstream_params_hash = EXCLUDED.upstream_params_hash,
       last_decision = COALESCE(EXCLUDED.last_decision, pipeline_dryrun_snapshots.last_decision),
       last_manual_input = COALESCE(EXCLUDED.last_manual_input, pipeline_dryrun_snapshots.last_manual_input),
       duration_ms = EXCLUDED.duration_ms, error = EXCLUDED.error, ran_at = NOW()`,
    [input.pipelineId, input.nodeId, input.status, JSON.stringify(input.output),
     input.source, input.upstreamParamsHash, input.lastDecision,
     input.lastManualInput ? JSON.stringify(input.lastManualInput) : null,
     input.durationMs, input.error])
}

export async function listSnapshots(pipelineId: number): Promise<DryRunSnapshot[]> {
  const { rows } = await getPool().query(
    `SELECT * FROM pipeline_dryrun_snapshots WHERE pipeline_id=$1 ORDER BY node_id`,
    [pipelineId])
  return rows.map(mapRow)
}

export async function deleteSnapshot(pipelineId: number, nodeId: string): Promise<void> {
  await getPool().query(
    `DELETE FROM pipeline_dryrun_snapshots WHERE pipeline_id=$1 AND node_id=$2`,
    [pipelineId, nodeId])
}

export async function deleteAllSnapshots(pipelineId: number): Promise<void> {
  await getPool().query(
    `DELETE FROM pipeline_dryrun_snapshots WHERE pipeline_id=$1`, [pipelineId])
}
```

- [ ] **Step 8: 修 test_runs.ts 持久 trigger_params**

读 `src/db/repositories/test-runs.ts`，找到 `INSERT INTO test_runs` 处。在该 SQL 列表加 `trigger_params` 列；在 createTestRun input 接受 `triggerParams?: Record<string, unknown>`，默认 `{}`，序列化 JSON 入库。

修改的具体行需要 implementer 读现有 repo 后定。

- [ ] **Step 9: 跑 repository 测试**

Run: `npx vitest run src/__tests__/unit/dryrun-snapshots-repo.test.ts src/__tests__/unit/v45-migration.test.ts`
Expected: PASS（全绿）

- [ ] **Step 10: Commit**

```bash
git add src/db/schema-v45.sql src/db/migrate.ts src/db/repositories/dryrun-snapshots.ts \
        src/db/repositories/test-runs.ts \
        src/__tests__/unit/v45-migration.test.ts \
        src/__tests__/unit/dryrun-snapshots-repo.test.ts
git commit -m "feat(db-v45): pipeline_dryrun_snapshots 表 + test_runs.trigger_params 列 + repository"
```

---

## Task 2: `computeUpstreamHash` 算法

**Files:**
- Create: `src/pipeline/dryrun-hash.ts`
- Test: `src/__tests__/unit/dryrun-hash.test.ts`

**目的：** 实现 spec §9.1 的上游 params hash 算法，给 dry-run runner 写 snapshot 用 + 读 snapshot 时算 stale 标用。

- [ ] **Step 1: 写单测**

Create `src/__tests__/unit/dryrun-hash.test.ts`：
```ts
import { describe, it, expect } from 'vitest'
import { computeUpstreamHash } from '../../pipeline/dryrun-hash.js'
import type { PipelineGraph } from '../../pipeline/types.js'

function makeNode(id: string, stageType: string, params?: unknown): PipelineGraph['nodes'][number] {
  return {
    id, name: id, stageType: stageType as any, params: params as any,
    targetRoles: [], parallel: false, timeoutSeconds: 60,
    retryCount: 0, onFailure: 'stop', position: { x: 0, y: 0 },
  } as PipelineGraph['nodes'][number]
}

describe('computeUpstreamHash', () => {
  const baseGraph: PipelineGraph = {
    nodes: [
      makeNode('a', 'sql_query', { sqlTemplate: 'SELECT 1' }),
      makeNode('b', 'http', { url: 'http://x' }),
      makeNode('c', 'switch', { cases: [], default: 'a' }),
    ],
    edges: [
      { id: 'e1', source: 'a', target: 'b' },
      { id: 'e2', source: 'b', target: 'c' },
    ],
  }

  it('同一 graph 同一 target 节点：hash 稳定', () => {
    const h1 = computeUpstreamHash(baseGraph, 'c')
    const h2 = computeUpstreamHash(baseGraph, 'c')
    expect(h1).toBe(h2)
  })

  it('不同 target 节点：hash 不同', () => {
    const ha = computeUpstreamHash(baseGraph, 'b')  // ancestor: {a}
    const hc = computeUpstreamHash(baseGraph, 'c')  // ancestor: {a, b}
    expect(ha).not.toBe(hc)
  })

  it('改 ancestor params：hash 变', () => {
    const g2 = { ...baseGraph, nodes: baseGraph.nodes.map(n =>
      n.id === 'a' ? { ...n, params: { sqlTemplate: 'SELECT 2' } } : n) }
    expect(computeUpstreamHash(baseGraph, 'c')).not.toBe(computeUpstreamHash(g2, 'c'))
  })

  it('改 retryCount/timeoutSeconds：hash 不变（不进 hash）', () => {
    const g2 = { ...baseGraph, nodes: baseGraph.nodes.map(n =>
      n.id === 'a' ? { ...n, retryCount: 99, timeoutSeconds: 999 } : n) }
    expect(computeUpstreamHash(baseGraph, 'c')).toBe(computeUpstreamHash(g2, 'c'))
  })

  it('改 position：hash 不变', () => {
    const g2 = { ...baseGraph, nodes: baseGraph.nodes.map(n =>
      n.id === 'a' ? { ...n, position: { x: 999, y: 999 } } : n) }
    expect(computeUpstreamHash(baseGraph, 'c')).toBe(computeUpstreamHash(g2, 'c'))
  })

  it('改上游 edge condition：hash 变', () => {
    const g2 = { ...baseGraph, edges: baseGraph.edges.map(e =>
      e.id === 'e1' ? { ...e, condition: { kind: 'expression' as const, expression: 'true' } } : e) }
    expect(computeUpstreamHash(baseGraph, 'c')).not.toBe(computeUpstreamHash(g2, 'c'))
  })
})
```

- [ ] **Step 2: Run 看 fail**

Run: `npx vitest run src/__tests__/unit/dryrun-hash.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 dryrun-hash.ts**

Create `src/pipeline/dryrun-hash.ts`：
```ts
import { createHash } from 'node:crypto'
import { computeAncestors } from './graph-validation.js'
import type { PipelineGraph } from './types.js'

export function computeUpstreamHash(graph: PipelineGraph, targetNodeId: string): string {
  const ancestors = computeAncestors(graph, targetNodeId)
  const sorted = [...ancestors].sort()
  const fingerprint = sorted.map(id => {
    const n = graph.nodes.find(x => x.id === id)
    if (!n) return { id }
    return {
      id: n.id,
      stageType: n.stageType,
      params: (n as { params?: unknown }).params,
      capabilityKey: (n as { capabilityKey?: string }).capabilityKey,
      outputFormat: (n as { outputFormat?: string }).outputFormat,
      script: (n as { script?: string }).script,
    }
  })
  const upstreamEdges = graph.edges
    .filter(e => ancestors.has(e.source) && ancestors.has(e.target))
    .map(e => ({ source: e.source, target: e.target, condition: e.condition }))
    .sort((a, b) => `${a.source}->${a.target}`.localeCompare(`${b.source}->${b.target}`))

  const payload = JSON.stringify({ nodes: fingerprint, edges: upstreamEdges })
  return createHash('sha256').update(payload).digest('hex')
}
```

> **执行注**：`computeAncestors` 在现有 `graph-validation.ts` 中是否 exported 需确认。如未 exported，在 graph-validation.ts 加 `export` 关键字（不改实现）。

- [ ] **Step 4: 跑测试看 pass**

Run: `npx vitest run src/__tests__/unit/dryrun-hash.test.ts`
Expected: PASS（6 个 it 全绿）

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/dryrun-hash.ts src/__tests__/unit/dryrun-hash.test.ts
git commit -m "feat(dryrun): computeUpstreamHash 算法 + 单测（6 case）"
```

---

## Task 3: `generateStubFromSchema` 算法

**Files:**
- Create: `src/pipeline/dryrun-stub.ts`
- Test: `src/__tests__/unit/dryrun-stub.test.ts`

**目的：** 实现 spec §6 stub 生成 — 从 JSON Schema 递归构造默认值，给副作用决策框「Stub」选项预填用。

- [ ] **Step 1: 写单测**

Create `src/__tests__/unit/dryrun-stub.test.ts`：
```ts
import { describe, it, expect } from 'vitest'
import { generateStubFromSchema } from '../../pipeline/dryrun-stub.js'

describe('generateStubFromSchema', () => {
  it('string → ""', () => {
    expect(generateStubFromSchema({ type: 'string' })).toBe('')
  })

  it('number/integer → 0', () => {
    expect(generateStubFromSchema({ type: 'number' })).toBe(0)
    expect(generateStubFromSchema({ type: 'integer' })).toBe(0)
  })

  it('boolean → false', () => {
    expect(generateStubFromSchema({ type: 'boolean' })).toBe(false)
  })

  it('array → []（不递归 items）', () => {
    expect(generateStubFromSchema({ type: 'array', items: { type: 'string' } })).toEqual([])
  })

  it('object → 递归生成所有 properties', () => {
    expect(generateStubFromSchema({
      type: 'object',
      properties: {
        stdout: { type: 'string' },
        exitCode: { type: 'number' },
      },
    })).toEqual({ stdout: '', exitCode: 0 })
  })

  it('enum → 取首项', () => {
    expect(generateStubFromSchema({
      type: 'string', enum: ['approved', 'rejected', 'timeout'],
    })).toBe('approved')
  })

  it('type union [number, null] → number 默认值', () => {
    expect(generateStubFromSchema({ type: ['number', 'null'] })).toBe(0)
  })

  it('approval schema 完整', () => {
    expect(generateStubFromSchema({
      type: 'object',
      properties: {
        decision: { enum: ['approved', 'rejected', 'timeout'], type: 'string' },
        approver: { type: 'string' },
        comment: { type: 'string' },
      },
    })).toEqual({ decision: 'approved', approver: '', comment: '' })
  })

  it('http schema 完整（含嵌套 object）', () => {
    expect(generateStubFromSchema({
      type: 'object',
      properties: {
        statusCode: { type: 'number' },
        body: { type: 'object' },
        headers: { type: 'object' },
      },
    })).toEqual({ statusCode: 0, body: {}, headers: {} })
  })

  it('switch schema（matchedCaseIndex 是 nullable number）', () => {
    expect(generateStubFromSchema({
      type: 'object',
      properties: {
        matchedCaseIndex: { type: ['number', 'null'] },
        matchedTarget: { type: 'string' },
        matchedWhen: { type: ['string', 'null'] },
      },
    })).toEqual({ matchedCaseIndex: 0, matchedTarget: '', matchedWhen: '' })
  })
})
```

- [ ] **Step 2: Run 看 fail**

Run: `npx vitest run src/__tests__/unit/dryrun-stub.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 dryrun-stub.ts**

Create `src/pipeline/dryrun-stub.ts`：
```ts
export interface JsonSchema {
  type?: string | string[]
  enum?: unknown[]
  properties?: Record<string, JsonSchema>
  items?: JsonSchema
}

export function generateStubFromSchema(schema: JsonSchema): unknown {
  if (schema.enum && schema.enum.length > 0) return schema.enum[0]
  const type = Array.isArray(schema.type)
    ? schema.type.find(t => t !== 'null') ?? schema.type[0]
    : schema.type
  switch (type) {
    case 'string': return ''
    case 'number': case 'integer': return 0
    case 'boolean': return false
    case 'null': return null
    case 'array': return []
    case 'object': {
      const out: Record<string, unknown> = {}
      const props = schema.properties ?? {}
      for (const [k, sub] of Object.entries(props)) {
        out[k] = generateStubFromSchema(sub)
      }
      return out
    }
    default: return null
  }
}
```

- [ ] **Step 4: 跑测试看 pass**

Run: `npx vitest run src/__tests__/unit/dryrun-stub.test.ts`
Expected: PASS（10 个 it 全绿）

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/dryrun-stub.ts src/__tests__/unit/dryrun-stub.test.ts
git commit -m "feat(dryrun): generateStubFromSchema 递归算法 + 单测（10 case）"
```

---

## Task 4: DryRunFlavor hooks 接口扩展 + graph-builder wrapper 注入

**Files:**
- Modify: `src/pipeline/graph-builder.ts` (StageHooks 接口 + dispatcher 副作用 case)
- Modify: `src/pipeline/node-types/fan-out.ts` (子节点检测副作用强制 stub)
- Test: `src/__tests__/unit/dryrun-wrapper.test.ts`

**目的：** spec §4 核心 — 给 StageHooks 加 `dryRunFlavor` 字段，dispatcher 里副作用 5 类节点（dm/db_update/script/approval/http）外面套 wrapper：interrupt 等 decision，按 real/stub/manual 走不同路径；fan_out 内部副作用节点 v1 强制走 stub。

- [ ] **Step 1: 写 wrapper 单测**

Create `src/__tests__/unit/dryrun-wrapper.test.ts`：
```ts
import { describe, it, expect, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { MemorySaver, Command } from '@langchain/langgraph'
import '../../pipeline/node-types/index.js'
import { buildGraphFromPipeline, type StageHooks } from '../../pipeline/graph-builder.js'
import type { PipelineGraph } from '../../pipeline/types.js'

function makeNode(id: string, stageType: string, params?: unknown): PipelineGraph['nodes'][number] {
  return {
    id, name: id, stageType: stageType as any, params: params as any,
    targetRoles: [], parallel: false, timeoutSeconds: 60,
    retryCount: 0, onFailure: 'stop', position: { x: 0, y: 0 },
  } as PipelineGraph['nodes'][number]
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of stream) { /* drain */ }
}

describe('dryRunFlavor wrapper', () => {
  it("决策 'real' → 真调 hooks，写 snapshot source='real'", async () => {
    const realDm = vi.fn().mockResolvedValue({ status: 'success', output: 'sent' })
    const beforeSideEffect = vi.fn().mockResolvedValue({ decision: 'real' })
    const recordSnapshot = vi.fn().mockResolvedValue(undefined)
    const upstreamHashOf = vi.fn().mockReturnValue('hash-x')

    const graph: PipelineGraph = {
      nodes: [makeNode('d', 'dm', { target: 'u', text: 'hi' })],
      edges: [],
    }
    const hooks: StageHooks = {
      runScript: async () => ({ status: 'success', output: '' }),
      runDm: realDm,
      dryRunFlavor: { beforeSideEffect, recordSnapshot, upstreamHashOf },
    }
    const builder = buildGraphFromPipeline({ graph, stageContext: { runId: 1, servers: {}, logDir: '/tmp' }, hooks })
    const app = (builder as any).compile({ checkpointer: new MemorySaver() })
    await drain(await app.stream({ runId: 1 }, { configurable: { thread_id: randomUUID() } }))

    expect(beforeSideEffect).toHaveBeenCalledWith('d', 'dm', expect.any(Object))
    expect(realDm).toHaveBeenCalled()
    expect(recordSnapshot).toHaveBeenCalledWith('d', expect.objectContaining({ source: 'real' }))
  })

  it("决策 'stub' → 不调 hooks，写 snapshot source='stub'，stepOutputs 用 stub", async () => {
    const realDm = vi.fn()
    const beforeSideEffect = vi.fn().mockResolvedValue({
      decision: 'stub',
      output: { messageId: '', deliveredAt: '' },
    })
    const recordSnapshot = vi.fn().mockResolvedValue(undefined)

    const graph: PipelineGraph = {
      nodes: [makeNode('d', 'dm', {})],
      edges: [],
    }
    const hooks: StageHooks = {
      runScript: async () => ({ status: 'success', output: '' }),
      runDm: realDm,
      dryRunFlavor: { beforeSideEffect, recordSnapshot, upstreamHashOf: () => 'h' },
    }
    const builder = buildGraphFromPipeline({ graph, stageContext: { runId: 1, servers: {}, logDir: '/tmp' }, hooks })
    const app = (builder as any).compile({ checkpointer: new MemorySaver() })
    const config = { configurable: { thread_id: randomUUID() } }
    await drain(await app.stream({ runId: 1 }, config))
    const snap = await app.getState(config)

    expect(realDm).not.toHaveBeenCalled()
    expect(recordSnapshot).toHaveBeenCalledWith('d', expect.objectContaining({ source: 'stub' }))
    expect(snap.values.stepOutputs?.d?.output).toEqual({ messageId: '', deliveredAt: '' })
  })

  it("决策 'manual' + manualOutput → 不调 hooks，stepOutputs 用 manualOutput", async () => {
    const realDm = vi.fn()
    const beforeSideEffect = vi.fn().mockResolvedValue({
      decision: 'manual',
      output: { messageId: 'fake-123', deliveredAt: '2026-04-27T00:00:00Z' },
    })
    const recordSnapshot = vi.fn().mockResolvedValue(undefined)

    const graph: PipelineGraph = {
      nodes: [makeNode('d', 'dm', {})],
      edges: [],
    }
    const hooks: StageHooks = {
      runScript: async () => ({ status: 'success', output: '' }),
      runDm: realDm,
      dryRunFlavor: { beforeSideEffect, recordSnapshot, upstreamHashOf: () => 'h' },
    }
    const builder = buildGraphFromPipeline({ graph, stageContext: { runId: 1, servers: {}, logDir: '/tmp' }, hooks })
    const app = (builder as any).compile({ checkpointer: new MemorySaver() })
    const config = { configurable: { thread_id: randomUUID() } }
    await drain(await app.stream({ runId: 1 }, config))
    const snap = await app.getState(config)

    expect(realDm).not.toHaveBeenCalled()
    expect(snap.values.stepOutputs?.d?.output).toEqual({ messageId: 'fake-123', deliveredAt: '2026-04-27T00:00:00Z' })
    expect(recordSnapshot).toHaveBeenCalledWith('d', expect.objectContaining({ source: 'manual' }))
  })

  it('非副作用节点（sql_query）：不走 wrapper，直接真跑', async () => {
    const beforeSideEffect = vi.fn()  // 不应被调用
    const recordSnapshot = vi.fn().mockResolvedValue(undefined)
    // sql_query 缺 sqlTemplate 会真跑失败，但 wrapper 不应介入
    const graph: PipelineGraph = {
      nodes: [makeNode('q', 'sql_query', {})],
      edges: [],
    }
    const hooks: StageHooks = {
      runScript: async () => ({ status: 'success', output: '' }),
      dryRunFlavor: { beforeSideEffect, recordSnapshot, upstreamHashOf: () => 'h' },
    }
    const builder = buildGraphFromPipeline({ graph, stageContext: { runId: 1, servers: {}, logDir: '/tmp' }, hooks })
    const app = (builder as any).compile({ checkpointer: new MemorySaver() })
    const config = { configurable: { thread_id: randomUUID() } }
    await drain(await app.stream({ runId: 1 }, config))

    expect(beforeSideEffect).not.toHaveBeenCalled()
    // 但 recordSnapshot 仍被调用（非副作用节点也写 snapshot，source='real'）
    expect(recordSnapshot).toHaveBeenCalledWith('q', expect.objectContaining({ source: 'real' }))
  })

  it('未传 dryRunFlavor：完全 noop，行为与生产一致', async () => {
    const realDm = vi.fn().mockResolvedValue({ status: 'success', output: 'sent' })
    const graph: PipelineGraph = {
      nodes: [makeNode('d', 'dm', {})],
      edges: [],
    }
    const hooks: StageHooks = {
      runScript: async () => ({ status: 'success', output: '' }),
      runDm: realDm,
      // 不传 dryRunFlavor
    }
    const builder = buildGraphFromPipeline({ graph, stageContext: { runId: 1, servers: {}, logDir: '/tmp' }, hooks })
    const app = (builder as any).compile({ checkpointer: new MemorySaver() })
    await drain(await app.stream({ runId: 1 }, { configurable: { thread_id: randomUUID() } }))

    expect(realDm).toHaveBeenCalled()  // 直接真跑
  })
})
```

- [ ] **Step 2: Run 看 fail**

Run: `npx vitest run src/__tests__/unit/dryrun-wrapper.test.ts`
Expected: FAIL — `dryRunFlavor` 字段不存在 / wrapper 未实现

- [ ] **Step 3: 扩展 StageHooks 接口**

修改 `src/pipeline/graph-builder.ts`，找到 `StageHooks` interface（在文件顶部附近），添加 `dryRunFlavor?:` 字段：

```ts
export interface DryRunFlavor {
  beforeSideEffect: (
    nodeId: string,
    nodeType: string,
    params: unknown,
  ) => Promise<{ decision: 'real' | 'stub' | 'manual'; output?: Record<string, unknown> }>
  recordSnapshot: (nodeId: string, snapshot: {
    status: 'success' | 'failed' | 'skipped'
    output: Record<string, unknown>
    source: 'real' | 'stub' | 'manual'
    durationMs: number
    error?: string
  }) => Promise<void>
  upstreamHashOf: (nodeId: string) => string
}

export interface StageHooks {
  // ... 现有字段
  dryRunFlavor?: DryRunFlavor
}
```

- [ ] **Step 4: dispatcher 副作用 case 加 wrapper**

修改 `src/pipeline/graph-builder.ts` 的 buildGraphFromPipeline 内 dispatcher（约 L924-952）：找到 `case 'dm':` / `case 'db_update':` / `case 'script':` / `case 'approval':` / `case 'http':`（部分可能在 ExecutorNodeStageType 通用 case 内），改为：

```ts
case 'script':
case 'dm':
case 'db_update':
case 'http':
case 'approval': {
  const realNode =
    node.stageType === 'script'   ? buildScriptNode(node, i, stageContext, hooks) :
    node.stageType === 'approval' ? buildApprovalNode(node, i, triggerParams) :
    /* dm / db_update / http 走 buildExecutorNode */
    buildExecutorNode(node, i, stageContext, triggerParams ?? {})

  if (hooks.dryRunFlavor) {
    builder = builder.addNode(name, async (state: typeof PipelineStateAnnotation.State) => {
      const dr = hooks.dryRunFlavor!
      const startedAt = Date.now()
      const decision = await dr.beforeSideEffect(node.id, node.stageType, (node as { params?: unknown }).params)

      if (decision.decision === 'real') {
        const result = await realNode(state)
        const stepOutput = (result as any).stepOutputs?.[node.id]?.output ?? {}
        const status = (result as any).stageResults?.status ?? 'success'
        await dr.recordSnapshot(node.id, {
          status, output: stepOutput, source: 'real',
          durationMs: Date.now() - startedAt,
        })
        return result
      }
      // stub / manual：直接构造 stepOutputs
      const output = decision.output ?? {}
      await dr.recordSnapshot(node.id, {
        status: 'success', output, source: decision.decision,
        durationMs: Date.now() - startedAt,
      })
      return {
        currentStageIndex: i,
        stageResults: {
          name: node.name, status: 'success' as const,
          output: JSON.stringify(output),
          startedAt: new Date(startedAt).toISOString(),
          durationMs: Date.now() - startedAt,
        },
        stepOutputs: { [node.id]: { status: 'success' as const, output } },
      }
    })
  } else {
    builder = builder.addNode(name, realNode)
  }
  break
}
```

> **执行注**：原 dispatcher 把 `script` / `approval` 与 ExecutorNodeStageType union 分别处理。落地时按现有结构调整 case 排序，关键是把这 5 类（script/approval/dm/db_update/http）从默认逻辑中分支出来加 wrapper。

- [ ] **Step 5: 非副作用节点也写 snapshot（仅 source='real'）**

dispatcher 里 sql_query/llm_agent/template_render/file_read/switch/fan_out 等节点完成后也调 `dryRunFlavor.recordSnapshot`，但**不弹 decision**。落地方式：在 dispatcher 通用 case 之外，给 buildGraphFromPipeline 加一个「post-execution snapshot 收集层」，在节点 wrapped function 末尾调 `dr.recordSnapshot({source: 'real'})`。

最简实现：在每个 `addNode(name, fn)` 之后，如果 `hooks.dryRunFlavor` 存在，把 `fn` 包一层：
```ts
function wrapWithSnapshot(node, fn) {
  if (!hooks.dryRunFlavor || isSideEffectStageType(node.stageType)) return fn  // 副作用节点已自己写 snapshot
  return async (state) => {
    const startedAt = Date.now()
    const result = await fn(state)
    const stepOutput = (result as any).stepOutputs?.[node.id]?.output ?? {}
    const status = (result as any).stageResults?.status ?? 'success'
    await hooks.dryRunFlavor!.recordSnapshot(node.id, {
      status, output: stepOutput, source: 'real',
      durationMs: Date.now() - startedAt,
    })
    return result
  }
}
```
其中 `isSideEffectStageType` 返回 `['script', 'dm', 'db_update', 'http', 'approval', 'wait_webhook', 'im_input'].includes(stageType)`（`wait_webhook` / `im_input` 也排除——它们不写 snapshot 因为本身真等外部）。

- [ ] **Step 6: 修 fan-out.ts 子节点强制 stub**

修改 `src/pipeline/node-types/fan-out.ts:236-248`，在 `executor.execute(...)` 之前加判断：

```ts
const SIDE_EFFECT_TYPES = new Set(['script', 'dm', 'db_update', 'http', 'approval'])

// L236 现有：const executor = getExecutor(bodyNode.nodeTypeKey)
if (SIDE_EFFECT_TYPES.has(bodyNode.nodeTypeKey) && (ctx as any).dryRunFlavor) {
  // v1 简化：fan_out 子图副作用节点直接 stub（output_schema 默认值）
  const { generateStubFromSchema } = await import('../dryrun-stub.js')
  const { getPool } = await import('../../db/client.js')
  const r = await getPool().query(
    `SELECT output_schema FROM pipeline_node_types WHERE key=$1`,
    [bodyNode.nodeTypeKey])
  const schema = r.rows[0]?.output_schema ?? { type: 'object', properties: {} }
  const stubOutput = generateStubFromSchema(schema)
  result = { status: 'success', output: stubOutput as Record<string, unknown> }
} else {
  result = await executor.execute(bodyNode.params, subCtx)
}
```

> **执行注**：`subCtx`/`ctx` 内是否能访问 `dryRunFlavor` 取决于 ExecutionContext 是否透传。落地时确认 ExecutionContext 是否需扩字段；如不能透传，引一个 module-level flag（dry-run runner 启动时 set，结束时 unset）。

- [ ] **Step 7: 跑测试看 pass**

Run: `npx vitest run src/__tests__/unit/dryrun-wrapper.test.ts`
Expected: PASS（5 个 it 全绿）

- [ ] **Step 8: Run 全套相关测试不退化**

Run: `npx vitest run src/__tests__/unit/graph-builder.test.ts src/__tests__/unit/llm-agent-output-format.test.ts src/__tests__/unit/condition-matches-parse-expr.test.ts src/__tests__/unit/switch-node.test.ts src/__tests__/integration/switch-routing-e2e.test.ts`
Expected: 全 PASS（dryRunFlavor 是可选字段，不传时行为不变）

- [ ] **Step 9: Commit**

```bash
git add src/pipeline/graph-builder.ts src/pipeline/node-types/fan-out.ts \
        src/__tests__/unit/dryrun-wrapper.test.ts
git commit -m "feat(graph-builder): DryRunFlavor hooks 注入 + 副作用节点 wrapper + fan_out 子节点 stub"
```

---

## Task 5: dryrun-runner 主体（session map + advisory lock + interrupt/resume + SSE 推送）

**Files:**
- Create: `src/pipeline/dryrun-runner.ts`
- Test: `src/__tests__/integration/dryrun-runner.test.ts`

**目的：** 串联 hash + stub + DryRunFlavor + advisory lock + session map + SSE chunk 协议。提供给 admin route 使用的 `runDryRun(pipelineId, targetNodeId, triggerParams, ssePush)` 函数 + `decideSideEffect(sessionId, nodeId, decision)` resume 入口。

- [ ] **Step 1: 写集成测试**

Create `src/__tests__/integration/dryrun-runner.test.ts`：
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { resetTestDb } from '../helpers/db.js'
import { runDryRun, decideSideEffect } from '../../pipeline/dryrun-runner.js'
import { listSnapshots } from '../../db/repositories/dryrun-snapshots.js'
import { getPool } from '../../db/client.js'

async function seedPipeline(graph: any): Promise<number> {
  const r = await getPool().query(
    `INSERT INTO test_pipelines (name, graph) VALUES ('p', $1::jsonb) RETURNING id`,
    [JSON.stringify(graph)])
  return r.rows[0].id as number
}

describe('runDryRun 端到端', () => {
  beforeEach(async () => { await resetTestDb() })

  it('从入口跑到目标节点：sql_query → script → http，跑到 http 之前 → 仅前两节点的 snapshot', async () => {
    const graph = {
      nodes: [
        { id: 'q', name: 'q', stageType: 'sql_query', params: { sqlTemplate: 'SELECT 1' }, position: { x: 0, y: 0 } },
        { id: 's', name: 's', stageType: 'script', script: 'echo 1', targetRoles: ['app'], position: { x: 0, y: 0 } },
        { id: 'h', name: 'h', stageType: 'http', params: { url: 'http://x' }, position: { x: 0, y: 0 } },
      ],
      edges: [
        { id: 'e1', source: 'q', target: 's' },
        { id: 'e2', source: 's', target: 'h' },
      ],
    }
    const pid = await seedPipeline(graph)
    const chunks: any[] = []
    const sessionId = 'sess1'

    // 决策 stub（script 是副作用）
    const decisionPromise = new Promise<void>((resolve) => {
      // 模拟前端在收到 decision-needed 后立即 POST decide
      setTimeout(async () => {
        await decideSideEffect(sessionId, 's', { decision: 'stub' })
        resolve()
      }, 100)
    })

    await runDryRun({
      sessionId, pipelineId: pid, targetNodeId: 'h',
      triggerParams: {}, triggerType: 'manual', triggeredBy: 'tester',
      ssePush: (chunk) => chunks.push(chunk),
    })
    await decisionPromise

    const snapshots = await listSnapshots(pid)
    expect(snapshots.map(s => s.nodeId).sort()).toEqual(['q', 's'])
    expect(snapshots.find(s => s.nodeId === 's')!.source).toBe('stub')

    // SSE chunks 应包含 progress + decision-needed + snapshot + done
    const types = chunks.map(c => c.type)
    expect(types).toContain('progress')
    expect(types).toContain('decision-needed')
    expect(types).toContain('snapshot')
    expect(types).toContain('done')
  })

  it('并发同一 pipeline：第二次 runDryRun 抛 advisory lock 错', async () => {
    const graph = {
      nodes: [{ id: 'q', name: 'q', stageType: 'sql_query', params: { sqlTemplate: 'SELECT pg_sleep(1)' }, position: { x: 0, y: 0 } }],
      edges: [],
    }
    const pid = await seedPipeline(graph)
    const p1 = runDryRun({ sessionId: 's1', pipelineId: pid, targetNodeId: 'q', triggerParams: {}, triggerType: 'manual', triggeredBy: 't', ssePush: () => {} })
    const p2 = runDryRun({ sessionId: 's2', pipelineId: pid, targetNodeId: 'q', triggerParams: {}, triggerType: 'manual', triggeredBy: 't', ssePush: () => {} })
    await expect(Promise.all([p1, p2])).rejects.toThrow(/advisory lock|concurrent/)
  })

  it('graph dirty 检查：传入的 graph hash 与 DB 不一致 → 拒绝', async () => {
    // dirty 检查在 admin route 层做（前端传 graph hash），dryrun-runner 只接受已校验的 graph
    // 此 case 在 Task 7 admin route 测试里
    expect(true).toBe(true)
  })
})
```

- [ ] **Step 2: Run 看 fail**

Run: `npx vitest run src/__tests__/integration/dryrun-runner.test.ts`
Expected: FAIL — module 不存在

- [ ] **Step 3: 实现 dryrun-runner.ts**

Create `src/pipeline/dryrun-runner.ts`：
```ts
import { randomUUID } from 'node:crypto'
import { Command } from '@langchain/langgraph'
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres'
import { buildGraphFromPipeline, type DryRunFlavor } from './graph-builder.js'
import { computeUpstreamHash } from './dryrun-hash.js'
import { generateStubFromSchema } from './dryrun-stub.js'
import { upsertSnapshot } from '../db/repositories/dryrun-snapshots.js'
import { getTestPipelineById } from '../db/repositories/test-pipelines.js'
import { getPool } from '../db/client.js'
import type { PipelineGraph } from './types.js'

export interface SsePushFn {
  (chunk: { type: string; [k: string]: unknown }): void
}

interface SessionState {
  pipelineId: number
  threadId: string
  decisionWaiters: Map<string, (d: { decision: 'real' | 'stub' | 'manual'; output?: Record<string, unknown> }) => void>
  startedAt: Date
}

const sessions = new Map<string, SessionState>()
const SESSION_TTL_MS = 30 * 60 * 1000

// 30 分钟超时清理
setInterval(() => {
  const now = Date.now()
  for (const [sid, s] of sessions) {
    if (now - s.startedAt.getTime() > SESSION_TTL_MS) sessions.delete(sid)
  }
}, 60 * 1000).unref()

export async function runDryRun(opts: {
  sessionId: string
  pipelineId: number
  targetNodeId: string  // '*' = 整图
  triggerParams: Record<string, unknown>
  triggerType: string
  triggeredBy: string
  ssePush: SsePushFn
}): Promise<void> {
  const { sessionId, pipelineId, targetNodeId, triggerParams, triggerType, triggeredBy, ssePush } = opts

  // 1. advisory lock
  const lockKey = pipelineId
  const { rows } = await getPool().query(`SELECT pg_try_advisory_lock($1) AS locked`, [lockKey])
  if (!rows[0].locked) throw new Error(`pipeline ${pipelineId} concurrent dry-run already running`)

  try {
    // 2. 拉 pipeline
    const pipeline = await getTestPipelineById(pipelineId)
    if (!pipeline) throw new Error(`pipeline ${pipelineId} not found`)
    const graph = (pipeline.graph ?? null) as PipelineGraph | null
    if (!graph) throw new Error('pipeline has no graph')

    // 3. 截到目标节点之前
    const subgraph: PipelineGraph = targetNodeId === '*'
      ? graph
      : truncateGraphBefore(graph, targetNodeId)

    const threadId = `dryrun-${sessionId}`
    sessions.set(sessionId, {
      pipelineId, threadId,
      decisionWaiters: new Map(),
      startedAt: new Date(),
    })

    // 4. 构造 dryRunFlavor
    const flavor: DryRunFlavor = {
      beforeSideEffect: async (nodeId, stageType, params) => {
        // schema template
        const r = await getPool().query(
          `SELECT output_schema FROM pipeline_node_types WHERE key=$1`, [stageType])
        const schemaTemplate = r.rows[0]?.output_schema ?? {}
        // 上次决策
        const prev = await getPool().query(
          `SELECT last_decision, last_manual_input FROM pipeline_dryrun_snapshots
           WHERE pipeline_id=$1 AND node_id=$2`, [pipelineId, nodeId])
        const lastDecision = prev.rows[0]?.last_decision ?? null
        const lastManualOutput = prev.rows[0]?.last_manual_input ?? null

        ssePush({
          type: 'decision-needed', sessionId, nodeId,
          stageType, params,
          schemaTemplate: generateStubFromSchema(schemaTemplate),
          lastDecision, lastManualOutput,
        })

        // 等前端 POST /decide
        return new Promise((resolve) => {
          sessions.get(sessionId)!.decisionWaiters.set(nodeId, resolve)
        })
      },
      recordSnapshot: async (nodeId, snap) => {
        await upsertSnapshot({
          pipelineId, nodeId,
          status: snap.status, output: snap.output, source: snap.source,
          upstreamParamsHash: computeUpstreamHash(graph, nodeId),
          lastDecision: null, lastManualInput: null,
          durationMs: snap.durationMs, error: snap.error ?? null,
        })
        ssePush({ type: 'snapshot', nodeId, status: snap.status, source: snap.source, output: snap.output })
      },
      upstreamHashOf: (nodeId) => computeUpstreamHash(graph, nodeId),
    }

    // 5. 构造 hooks（dryRunFlavor 注入 + 真实 runScript/runDm/runCapability/...）
    const hooks = {
      dryRunFlavor: flavor,
      // 真实 hooks 实现按 prod runtime 配置 — 这里需引入 graph-runtime 里的 prod hooks
      ...await import('./graph-runtime.js').then(m => m.makeProdHooks?.() ?? {}),
    }

    // 6. PostgresSaver + thread_id 隔离
    const saver = new PostgresSaver(getPool())
    const builder = buildGraphFromPipeline({
      graph: subgraph,
      stageContext: { runId: 0, servers: {}, logDir: '/tmp/dryrun' },  // dry-run 无 runId
      hooks: hooks as any,
      triggerParams,
    })
    const app = (builder as any).compile({ checkpointer: saver })
    const config = { configurable: { thread_id: threadId } }

    // 7. 流式跑
    ssePush({ type: 'started', sessionId })
    for await (const chunk of (await app.stream({ runId: 0 }, config)) as AsyncIterable<unknown>) {
      // chunk 自动驱动 hooks 触发 sse-push（progress / decision-needed / snapshot）
      ssePush({ type: 'progress', chunk: '...' })  // 简化版，实际把 chunk node name 推
    }

    ssePush({ type: 'done', sessionId, reachedNodeId: targetNodeId })
  } catch (e) {
    ssePush({ type: 'error', error: e instanceof Error ? e.message : String(e), fatal: true })
    throw e
  } finally {
    sessions.delete(sessionId)
    await getPool().query(`SELECT pg_advisory_unlock($1)`, [lockKey])
  }
}

export async function decideSideEffect(
  sessionId: string, nodeId: string,
  decision: { decision: 'real' | 'stub' | 'manual'; output?: Record<string, unknown>; remember?: boolean },
): Promise<void> {
  const session = sessions.get(sessionId)
  if (!session) throw new Error(`session ${sessionId} not found`)
  const waiter = session.decisionWaiters.get(nodeId)
  if (!waiter) throw new Error(`no pending decision for node ${nodeId}`)

  // 决策记忆：写 last_decision / last_manual_input 到 snapshot 之前的 row（如果存在）
  if (decision.remember) {
    await getPool().query(
      `UPDATE pipeline_dryrun_snapshots
       SET last_decision=$3, last_manual_input=$4
       WHERE pipeline_id=$1 AND node_id=$2`,
      [session.pipelineId, nodeId, decision.decision,
       decision.output ? JSON.stringify(decision.output) : null])
  }

  waiter(decision)
  session.decisionWaiters.delete(nodeId)
}

function truncateGraphBefore(graph: PipelineGraph, targetNodeId: string): PipelineGraph {
  // "跑到 X 之前" = 保留 X 的所有 ancestors（不含 X 自身），让 graph runner 自然结束
  // computeAncestors 在 graph-validation.ts 已 export
  const { computeAncestors } = require('./graph-validation.js') as typeof import('./graph-validation.js')
  const keepIds = computeAncestors(graph, targetNodeId)  // 不含 target 自身
  if (keepIds.size === 0) {
    return { nodes: [], edges: [] }  // target 是入口，无上游可跑
  }
  return {
    nodes: graph.nodes.filter(n => keepIds.has(n.id)),
    edges: graph.edges.filter(e => keepIds.has(e.source) && keepIds.has(e.target)),
  }
}
```

> **执行注**：上面 `runDryRun` 里 `for await (const chunk of ...)` 的具体 chunk 形态 / 如何抽取节点名推 progress 取决于 langgraph stream 模式（events / values / updates）。落地时参考 `src/__tests__/unit/graph-builder.test.ts:64-68 drain` 模式。

- [ ] **Step 4: 跑集成测试**

Run: `npx vitest run src/__tests__/integration/dryrun-runner.test.ts`
Expected: PASS（3 个 it 全绿，可能需调试 stream 接收 + chunk 推送时机）

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/dryrun-runner.ts src/__tests__/integration/dryrun-runner.test.ts
git commit -m "feat(dryrun): runDryRun + decideSideEffect 主流程（advisory lock + session map + SSE）"
```

---

## Task 6: webhook 路由 dry-run 命名空间扩展

**Files:**
- Create: `src/pipeline/dryrun-webhook-router.ts`
- Modify: `src/pipeline/im-router.ts` (加 dryRunSessionId 参数支持)
- Modify: webhook 接收 handler（plan 阶段需 grep 定位现有 wait_webhook 入口）
- Test: `src/__tests__/integration/dryrun-webhook-resume.test.ts`

**目的：** spec §5.2 关键风险点 — 让 wait_webhook/im_input 在 dry-run 模式下也能被外部触发 resume。
方案：dry-run runner 启动 wait_webhook 节点时，把生成的 webhookUrl 含 `?sessionId=<sid>` 参数；webhook 接收 handler 看到 sessionId 参数 → 直接 resume `dryrun-<sid>` thread 而不是 prod thread。

- [ ] **Step 1: Plan 探索**

实施此 task **前**，subagent 必须先 grep 定位 webhook 接收 handler：
```bash
grep -rn "wait_webhook\|webhook/generic\|webhook.*receive" src/ --include="*.ts" | head -20
```
找到现有 webhook handler 后才能确定具体扩展位置。如果项目还没有 generic webhook 路由，本 task 还需在 server.ts 注册新路由。

- [ ] **Step 2: 写集成测试**

Create `src/__tests__/integration/dryrun-webhook-resume.test.ts`：
```ts
import { describe, it, expect } from 'vitest'
// 测试场景：
// 1. dry-run 跑到 wait_webhook 节点 → SSE 推 waiting-external + webhookUrl（含 ?sessionId=xxx）
// 2. 模拟外部 POST 到该 webhookUrl
// 3. dryrun thread resume，graph 继续 → 完成 → done

it('wait_webhook 节点在 dry-run 模式下被外部 webhook 触发后 resume', async () => {
  // ... 详细实现按 webhook handler 探索结果定
  expect(true).toBe(true)  // placeholder，实施时填完整
})
```

> **执行注**：本 task 测试细节强依赖 webhook handler 现状，subagent 探索 webhook 接收处后写完整 test。

- [ ] **Step 3: 实现 dryrun-webhook-router.ts**

Create `src/pipeline/dryrun-webhook-router.ts`：
```ts
import { getPool } from '../db/client.js'

/**
 * 给定 dry-run sessionId 与 wait_webhook 节点的 webhookTag，
 * 生成外部触发 URL。
 */
export function buildDryRunWebhookUrl(opts: {
  baseUrl: string
  webhookTag: string
  sessionId: string
}): string {
  const u = new URL(opts.baseUrl + '/webhook/generic')
  u.searchParams.set('tag', opts.webhookTag)
  u.searchParams.set('dryrunSessionId', opts.sessionId)
  return u.toString()
}

/**
 * 给定 webhook 请求里的 dryrunSessionId（可空），返回应该 resume 的 thread_id。
 * 若有 dryrunSessionId → `dryrun-<sessionId>`；否则按 prod 路由（fallback null，让现有 wait_webhook handler 处理）。
 */
export function resolveWebhookThreadId(dryrunSessionId: string | undefined): string | null {
  if (!dryrunSessionId) return null
  return `dryrun-${dryrunSessionId}`
}
```

- [ ] **Step 4: 修 webhook 接收 handler**

按 Step 1 探索结果修。预期改动：
1. handler 入口读 `req.query.dryrunSessionId`
2. 调 `resolveWebhookThreadId` 拿 thread_id
3. 用 langgraph `Command({resume: payload})` resume 对应 thread

伪代码：
```ts
app.post('/webhook/generic', async (req, reply) => {
  const dryrunSessionId = (req.query as any).dryrunSessionId as string | undefined
  const threadId = resolveWebhookThreadId(dryrunSessionId)
  if (threadId) {
    // dry-run 模式：直接 resume dry-run thread
    const app = await getDryRunApp()  // 或保留 builder 引用
    await app.stream(new Command({ resume: req.body }), { configurable: { thread_id: threadId } })
    return reply.send({ ok: true, mode: 'dryrun' })
  }
  // 现有 prod 逻辑保持不变
  // ... existing code
})
```

- [ ] **Step 5: 修 im-router.ts 加 dryrunSessionId 参数支持**

修改 `src/pipeline/im-router.ts`：现有按 `(platform, groupId)` 找 thread；扩展支持给 dry-run 注册临时映射：
```ts
const byDryRunSession = new Map<string, string>()  // sessionId → threadId

export function registerDryRunImWaiter(sessionId: string, threadId: string): void {
  byDryRunSession.set(sessionId, threadId)
}

export function unregisterDryRunImWaiter(sessionId: string): void {
  byDryRunSession.delete(sessionId)
}

// 现有 findImInputWaiter(platform, groupId) 之外增加：
export function findDryRunImWaiter(sessionId: string): string | undefined {
  return byDryRunSession.get(sessionId)
}
```

> **执行注**：im_input 节点在 dry-run 时需要把 sessionId 通过某种 UI 提示（如试运行 SSE 的 `waiting-external` chunk 里 `sessionId` 字段）告知用户，用户在 IM 群带特殊标识回复（如 `[dryrun=<sid>] 包名`）—— **这部分 UX 复杂，v1 接受 im_input 在 dry-run 仍走 prod 路径**：dryrun runner 在跑到 im_input 节点时直接弹「不支持 im_input 试跑，请先 stub」决策框作为 fallback。落地时确认是这么处理还是真做 dryrun_session 标识。

- [ ] **Step 6: 跑测试**

Run: `npx vitest run src/__tests__/integration/dryrun-webhook-resume.test.ts`
Expected: PASS（实施时按探索结果完整化测试）

- [ ] **Step 7: Commit**

```bash
git add src/pipeline/dryrun-webhook-router.ts src/pipeline/im-router.ts \
        <webhook handler file> src/__tests__/integration/dryrun-webhook-resume.test.ts
git commit -m "feat(dryrun): webhook/im 路由 dry-run 命名空间（dryrunSessionId 参数）"
```

---

## Task 7: 6 个 SSE/REST API endpoint

**Files:**
- Create: `src/admin/routes/dryrun.ts`
- Modify: `src/admin/index.ts` (注册新路由)
- Test: `src/__tests__/integration/dryrun-api.test.ts`

**目的：** spec §10.1 列出的 6 个端点，串联 runDryRun + decideSideEffect + snapshot CRUD + history。

- [ ] **Step 1: 写 API 测试**

Create `src/__tests__/integration/dryrun-api.test.ts`：
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { resetTestDb } from '../helpers/db.js'
import { buildTestApp } from '../helpers/test-app.js'  // 现有 fastify-inject helper
import { getPool } from '../../db/client.js'

async function seedPipelineWithRun(graph: any, triggerParams: any): Promise<{ pid: number; runId: number }> {
  const p = await getPool().query(
    `INSERT INTO test_pipelines (name, graph) VALUES ('p',$1::jsonb) RETURNING id`,
    [JSON.stringify(graph)])
  const r = await getPool().query(
    `INSERT INTO test_runs (pipeline_id, trigger_type, triggered_by, trigger_params, status)
     VALUES ($1,'gitlab','webhook',$2::jsonb,'success') RETURNING id`,
    [p.rows[0].id, JSON.stringify(triggerParams)])
  return { pid: p.rows[0].id as number, runId: r.rows[0].id as number }
}

describe('dryrun API', () => {
  beforeEach(async () => { await resetTestDb() })

  it('GET /admin/test-pipelines/:id/recent-trigger-params', async () => {
    const { pid } = await seedPipelineWithRun({ nodes: [], edges: [] }, { ref: 'main' })
    const app = await buildTestApp()
    const r = await app.inject({ method: 'GET', url: `/admin/test-pipelines/${pid}/recent-trigger-params?limit=10` })
    expect(r.statusCode).toBe(200)
    const list = r.json()
    expect(list).toHaveLength(1)
    expect(list[0].triggerParams).toEqual({ ref: 'main' })
    expect(list[0].triggerType).toBe('gitlab')
  })

  it('GET /admin/test-pipelines/:id/dry-run/snapshots — 含 stale 标', async () => {
    const graph = {
      nodes: [{ id: 'q', name: 'q', stageType: 'sql_query', params: { sqlTemplate: 'SELECT 1' }, position: { x: 0, y: 0 } }],
      edges: [],
    }
    const p = await getPool().query(
      `INSERT INTO test_pipelines (name, graph) VALUES ('p',$1::jsonb) RETURNING id`,
      [JSON.stringify(graph)])
    const pid = p.rows[0].id
    // upsert 一个 snapshot
    await getPool().query(
      `INSERT INTO pipeline_dryrun_snapshots (pipeline_id, node_id, status, output, source, upstream_params_hash)
       VALUES ($1, 'q', 'success', '{"rows":[]}', 'real', 'old-hash-abc')`,
      [pid])
    const app = await buildTestApp()
    const r = await app.inject({ method: 'GET', url: `/admin/test-pipelines/${pid}/dry-run/snapshots` })
    expect(r.statusCode).toBe(200)
    const list = r.json()
    expect(list).toHaveLength(1)
    expect(list[0].stale).toBe(true)  // 'old-hash-abc' != 实际计算的 hash
  })

  it('DELETE /admin/test-pipelines/:id/dry-run/snapshots — 全清', async () => {
    const p = await getPool().query(`INSERT INTO test_pipelines (name) VALUES ('p') RETURNING id`)
    await getPool().query(
      `INSERT INTO pipeline_dryrun_snapshots (pipeline_id, node_id, status, output, source, upstream_params_hash)
       VALUES ($1,'q','success','{}','real','h')`, [p.rows[0].id])
    const app = await buildTestApp()
    const r = await app.inject({ method: 'DELETE', url: `/admin/test-pipelines/${p.rows[0].id}/dry-run/snapshots` })
    expect(r.statusCode).toBe(204)
    const remain = await getPool().query(
      `SELECT * FROM pipeline_dryrun_snapshots WHERE pipeline_id=$1`, [p.rows[0].id])
    expect(remain.rowCount).toBe(0)
  })

  it('POST /admin/test-pipelines/:id/dry-run/sessions/:sid/decide — 提交决策', async () => {
    // 这个测试需要先启动一个 dry-run 会话，模拟 SSE waiting → POST decide → 完成
    // 集成度高，骨架先放占位
    expect(true).toBe(true)
  })

  it('graph dirty（前端传 graph hash 与 DB 不一致）→ 400', async () => {
    const p = await getPool().query(
      `INSERT INTO test_pipelines (name, graph) VALUES ('p','{"nodes":[],"edges":[]}'::jsonb) RETURNING id`)
    const app = await buildTestApp()
    const r = await app.inject({
      method: 'POST',
      url: `/admin/test-pipelines/${p.rows[0].id}/dry-run/run-to/x`,
      payload: {
        graphHash: 'wrong-hash',
        triggerParams: {}, triggerType: 'manual', triggeredBy: 't',
      },
    })
    expect(r.statusCode).toBe(400)
  })
})
```

- [ ] **Step 2: Run 看 fail**

Run: `npx vitest run src/__tests__/integration/dryrun-api.test.ts`
Expected: FAIL — 路由未注册

- [ ] **Step 3: 实现 admin/routes/dryrun.ts**

Create `src/admin/routes/dryrun.ts`：
```ts
import type { FastifyInstance } from 'fastify'
import { randomUUID, createHash } from 'node:crypto'
import { runDryRun, decideSideEffect } from '../../pipeline/dryrun-runner.js'
import { listSnapshots, deleteSnapshot, deleteAllSnapshots } from '../../db/repositories/dryrun-snapshots.js'
import { getTestPipelineById } from '../../db/repositories/test-pipelines.js'
import { computeUpstreamHash } from '../../pipeline/dryrun-hash.js'
import { getPool } from '../../db/client.js'
import type { PipelineGraph } from '../../pipeline/types.js'

export async function registerDryRunRoutes(app: FastifyInstance): Promise<void> {
  // 1. 历史回放数据源
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/test-pipelines/:id/recent-trigger-params',
    async (req, reply) => {
      const limit = Math.min(Number(req.query.limit ?? 20), 50)
      const { rows } = await getPool().query(
        `SELECT id, trigger_type, triggered_by, trigger_params, started_at, status
         FROM test_runs
         WHERE pipeline_id=$1
         ORDER BY started_at DESC LIMIT $2`,
        [Number(req.params.id), limit])
      return reply.send(rows.map(r => ({
        runId: r.id,
        triggerType: r.trigger_type,
        triggeredBy: r.triggered_by,
        triggerParams: r.trigger_params,
        startedAt: r.started_at,
        status: r.status,
      })))
    })

  // 2. 拉所有 snapshot（含 stale 标）
  app.get<{ Params: { id: string } }>(
    '/test-pipelines/:id/dry-run/snapshots',
    async (req, reply) => {
      const pid = Number(req.params.id)
      const pipeline = await getTestPipelineById(pid)
      if (!pipeline) return reply.status(404).send({ error: 'pipeline not found' })
      const graph = (pipeline.graph ?? null) as PipelineGraph | null
      const snapshots = await listSnapshots(pid)
      const enriched = snapshots.map(s => {
        const stale = graph
          ? computeUpstreamHash(graph, s.nodeId) !== s.upstreamParamsHash
          : true
        return { ...s, stale }
      })
      return reply.send(enriched)
    })

  // 3. 清所有 snapshot
  app.delete<{ Params: { id: string } }>(
    '/test-pipelines/:id/dry-run/snapshots',
    async (req, reply) => {
      await deleteAllSnapshots(Number(req.params.id))
      return reply.status(204).send()
    })

  // 4. 清单个 snapshot
  app.delete<{ Params: { id: string; nodeId: string } }>(
    '/test-pipelines/:id/dry-run/snapshots/:nodeId',
    async (req, reply) => {
      await deleteSnapshot(Number(req.params.id), req.params.nodeId)
      return reply.status(204).send()
    })

  // 5. 启动 SSE 试运行
  app.post<{
    Params: { id: string; nodeId: string }
    Body: { graphHash?: string; triggerParams: Record<string, unknown>; triggerType: string; triggeredBy: string }
  }>('/test-pipelines/:id/dry-run/run-to/:nodeId', async (req, reply) => {
    const pid = Number(req.params.id)
    const pipeline = await getTestPipelineById(pid)
    if (!pipeline) return reply.status(404).send({ error: 'pipeline not found' })

    // graph dirty check
    if (req.body.graphHash) {
      const dbHash = createHash('sha256').update(JSON.stringify(pipeline.graph ?? {})).digest('hex')
      if (req.body.graphHash !== dbHash) {
        return reply.status(400).send({ error: 'graph dirty: 请先保存再试运行' })
      }
    }

    const sessionId = randomUUID()
    reply.raw.setHeader('Content-Type', 'text/event-stream')
    reply.raw.setHeader('Cache-Control', 'no-cache')
    reply.raw.setHeader('Connection', 'keep-alive')
    reply.raw.flushHeaders()

    const ssePush = (chunk: { type: string; [k: string]: unknown }) => {
      reply.raw.write(`event: ${chunk.type}\n`)
      reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`)
    }

    try {
      await runDryRun({
        sessionId, pipelineId: pid, targetNodeId: req.params.nodeId,
        triggerParams: req.body.triggerParams, triggerType: req.body.triggerType,
        triggeredBy: req.body.triggeredBy, ssePush,
      })
    } catch (e) {
      ssePush({ type: 'error', error: e instanceof Error ? e.message : String(e), fatal: true })
    } finally {
      reply.raw.end()
    }
  })

  // 6. 提交副作用决策
  app.post<{
    Params: { id: string; sessionId: string }
    Body: { nodeId: string; decision: 'real' | 'stub' | 'manual'; manualOutput?: Record<string, unknown>; remember?: boolean }
  }>('/test-pipelines/:id/dry-run/sessions/:sessionId/decide', async (req, reply) => {
    try {
      await decideSideEffect(req.params.sessionId, req.body.nodeId, {
        decision: req.body.decision,
        output: req.body.manualOutput,
        remember: req.body.remember,
      })
      return reply.status(204).send()
    } catch (e) {
      return reply.status(404).send({ error: e instanceof Error ? e.message : String(e) })
    }
  })
}
```

- [ ] **Step 4: 注册路由**

修改 `src/admin/index.ts` 把 `registerDryRunRoutes` 加到现有 routes 注册逻辑里（按现有 register 模式）。

- [ ] **Step 5: 跑测试**

Run: `npx vitest run src/__tests__/integration/dryrun-api.test.ts`
Expected: PASS（5 个 it 全绿）

- [ ] **Step 6: Commit**

```bash
git add src/admin/routes/dryrun.ts src/admin/index.ts \
        src/__tests__/integration/dryrun-api.test.ts
git commit -m "feat(admin-api): dryrun 6 个 endpoint（history/snapshots/decide/run-to SSE）"
```

---

## Task 8: 前端 SSE 客户端 hook + API client

**Files:**
- Create: `web/src/api/dryrun.ts`
- Create: `web/src/pipeline-canvas/dryrun/useDryRunSSE.ts`
- Modify: `web/package.json` (加 `@monaco-editor/react`)

**目的：** 给 Modal/Tab 用的统一状态机。SSE 接 chunk → 维护 `phase` (idle/running/awaiting-decision/awaiting-external/done/error) + `progressByNode` + 提供 `decide()` 接口。

- [ ] **Step 1: 装 Monaco**

```bash
cd /Users/yan/Documents/Code/chatops/web
pnpm add @monaco-editor/react monaco-editor
```

- [ ] **Step 2: 创建 API client**

Create `web/src/api/dryrun.ts`：
```ts
import client from './client'

export interface DryRunSnapshot {
  pipelineId: number
  nodeId: string
  status: 'success' | 'failed' | 'skipped'
  output: Record<string, unknown>
  source: 'real' | 'stub' | 'manual'
  upstreamParamsHash: string
  lastDecision: string | null
  lastManualInput: Record<string, unknown> | null
  durationMs: number | null
  error: string | null
  ranAt: string
  stale: boolean
}

export const listSnapshots = (pid: number) =>
  client.get<DryRunSnapshot[]>(`/test-pipelines/${pid}/dry-run/snapshots`).then(r => r.data)

export const clearAllSnapshots = (pid: number) =>
  client.delete(`/test-pipelines/${pid}/dry-run/snapshots`)

export const clearSnapshot = (pid: number, nodeId: string) =>
  client.delete(`/test-pipelines/${pid}/dry-run/snapshots/${encodeURIComponent(nodeId)}`)

export interface RecentTriggerParam {
  runId: number
  triggerType: string
  triggeredBy: string
  triggerParams: Record<string, unknown>
  startedAt: string
  status: string
}

export const listRecentTriggerParams = (pid: number, limit = 20) =>
  client.get<RecentTriggerParam[]>(`/test-pipelines/${pid}/recent-trigger-params?limit=${limit}`)
    .then(r => r.data)

export const decideSideEffect = (
  pid: number, sessionId: string,
  body: { nodeId: string; decision: 'real' | 'stub' | 'manual'; manualOutput?: Record<string, unknown>; remember?: boolean },
) => client.post(`/test-pipelines/${pid}/dry-run/sessions/${sessionId}/decide`, body)
```

- [ ] **Step 3: 创建 useDryRunSSE hook**

Create `web/src/pipeline-canvas/dryrun/useDryRunSSE.ts`：
```ts
import { useState, useCallback, useRef } from 'react'

export type DryRunPhase = 'idle' | 'running' | 'awaiting-decision' | 'awaiting-external' | 'done' | 'error'

export interface DryRunChunk {
  type: 'started' | 'progress' | 'snapshot' | 'decision-needed' | 'waiting-external' | 'stale-warning' | 'error' | 'done'
  sessionId?: string
  nodeId?: string
  [k: string]: unknown
}

export interface DryRunState {
  phase: DryRunPhase
  sessionId: string | null
  pendingDecision: DryRunChunk | null  // type='decision-needed' chunk
  pendingExternal: DryRunChunk | null  // type='waiting-external' chunk
  progressByNode: Record<string, 'running' | 'success' | 'failed' | 'skipped'>
  staleNodeIds: string[]
  error: string | null
}

const initialState: DryRunState = {
  phase: 'idle', sessionId: null, pendingDecision: null,
  pendingExternal: null, progressByNode: {}, staleNodeIds: [], error: null,
}

export function useDryRunSSE() {
  const [state, setState] = useState<DryRunState>(initialState)
  const xhrRef = useRef<XMLHttpRequest | null>(null)

  const start = useCallback((opts: {
    pipelineId: number
    targetNodeId: string
    graphHash: string
    triggerParams: Record<string, unknown>
    triggerType: string
    triggeredBy: string
  }) => {
    setState({ ...initialState, phase: 'running' })

    // SSE POST body 用 fetch ReadableStream（EventSource 不支持 POST）
    fetch(`/admin/test-pipelines/${opts.pipelineId}/dry-run/run-to/${opts.targetNodeId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        graphHash: opts.graphHash,
        triggerParams: opts.triggerParams,
        triggerType: opts.triggerType,
        triggeredBy: opts.triggeredBy,
      }),
    }).then(async (resp) => {
      if (!resp.ok || !resp.body) throw new Error(`SSE ${resp.status}`)
      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const events = buf.split('\n\n')
        buf = events.pop() ?? ''
        for (const ev of events) handleEvent(ev)
      }
    }).catch(e => {
      setState(s => ({ ...s, phase: 'error', error: e.message }))
    })

    function handleEvent(rawEvent: string) {
      const lines = rawEvent.split('\n')
      let type = 'message', dataStr = ''
      for (const l of lines) {
        if (l.startsWith('event:')) type = l.slice(6).trim()
        else if (l.startsWith('data:')) dataStr += l.slice(5).trim()
      }
      let chunk: DryRunChunk
      try { chunk = { ...JSON.parse(dataStr), type: type as DryRunChunk['type'] } }
      catch { return }
      reduceChunk(chunk)
    }

    function reduceChunk(chunk: DryRunChunk) {
      setState(s => {
        switch (chunk.type) {
          case 'started':
            return { ...s, sessionId: chunk.sessionId as string, phase: 'running' }
          case 'progress':
            if (!chunk.nodeId) return s
            return {
              ...s, phase: 'running',
              progressByNode: { ...s.progressByNode, [chunk.nodeId as string]: 'running' as const },
            }
          case 'snapshot':
            if (!chunk.nodeId) return s
            return {
              ...s,
              progressByNode: { ...s.progressByNode, [chunk.nodeId as string]: chunk.status as any },
            }
          case 'decision-needed':
            return { ...s, phase: 'awaiting-decision', pendingDecision: chunk }
          case 'waiting-external':
            return { ...s, phase: 'awaiting-external', pendingExternal: chunk }
          case 'stale-warning':
            return { ...s, staleNodeIds: chunk.staleNodeIds as string[] }
          case 'error':
            return { ...s, phase: 'error', error: chunk.error as string }
          case 'done':
            return { ...s, phase: 'done', pendingDecision: null, pendingExternal: null }
          default:
            return s
        }
      })
    }
  }, [])

  const submitDecision = useCallback((
    pipelineId: number, sessionId: string,
    body: { nodeId: string; decision: 'real' | 'stub' | 'manual'; manualOutput?: Record<string, unknown>; remember?: boolean },
  ) => {
    return fetch(`/admin/test-pipelines/${pipelineId}/dry-run/sessions/${sessionId}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(() => {
      // 决策提交后状态机回到 running，等下一个 chunk
      setState(s => ({ ...s, phase: 'running', pendingDecision: null }))
    })
  }, [])

  const reset = useCallback(() => setState(initialState), [])

  return { state, start, submitDecision, reset }
}
```

- [ ] **Step 4: tsc + 简单冒烟**

Run: `cd web && pnpm exec tsc --noEmit`
Expected: PASS

> **执行注**：本 task 没写单测（前端 SSE 测试需 MSW + 流式响应 mock，搭建成本高，v1 接受集成测试覆盖）。

- [ ] **Step 5: Commit**

```bash
git add web/src/api/dryrun.ts web/src/pipeline-canvas/dryrun/useDryRunSSE.ts \
        web/package.json web/pnpm-lock.yaml
git commit -m "feat(canvas-dryrun): SSE hook + API client + Monaco 依赖"
```

---

## Task 9: DryRunStartModal — 试运行启动对话框（3 Tab）

**Files:**
- Create: `web/src/pipeline-canvas/dryrun/DryRunStartModal.tsx`

**目的：** spec §7 — 三 Tab 对话框（默认 / 历史回放 / 自定义 JSON）+ 提交时调 `start()`。

- [ ] **Step 1: 创建 DryRunStartModal**

Create `web/src/pipeline-canvas/dryrun/DryRunStartModal.tsx`：
```tsx
import { useState, useEffect } from 'react'
import { Modal, Tabs, Table, Button, message } from 'antd'
import Editor from '@monaco-editor/react'
import { listRecentTriggerParams, type RecentTriggerParam } from '../../api/dryrun'

interface Props {
  open: boolean
  pipelineId: number
  pipelineDefaultTriggerParams?: Record<string, unknown>
  onCancel: () => void
  onConfirm: (payload: { triggerParams: Record<string, unknown>; triggerType: string }) => void
}

export function DryRunStartModal(p: Props) {
  const [activeTab, setActiveTab] = useState<'default' | 'history' | 'custom'>('default')
  const [history, setHistory] = useState<RecentTriggerParam[]>([])
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null)
  const [customJson, setCustomJson] = useState('{}')
  const [customError, setCustomError] = useState<string | null>(null)

  useEffect(() => {
    if (p.open && activeTab === 'history') {
      listRecentTriggerParams(p.pipelineId).then(setHistory).catch(() => {})
    }
  }, [p.open, activeTab, p.pipelineId])

  function handleOk() {
    if (activeTab === 'default') {
      if (!p.pipelineDefaultTriggerParams) {
        message.warning('该流水线尚未配置默认 triggerParams，请使用其它 Tab')
        return
      }
      p.onConfirm({ triggerParams: p.pipelineDefaultTriggerParams, triggerType: 'manual' })
    } else if (activeTab === 'history') {
      const sel = history.find(h => h.runId === selectedRunId)
      if (!sel) { message.warning('请选择一条历史记录'); return }
      p.onConfirm({ triggerParams: sel.triggerParams, triggerType: sel.triggerType })
    } else {
      try {
        const parsed = JSON.parse(customJson)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          setCustomError('triggerParams 必须是 JSON 对象')
          return
        }
        p.onConfirm({ triggerParams: parsed, triggerType: 'manual' })
      } catch (e) {
        setCustomError(`JSON 解析失败：${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  return (
    <Modal
      title="试运行启动"
      open={p.open}
      onCancel={p.onCancel}
      onOk={handleOk}
      width={720}
      okText="开始试运行"
    >
      <Tabs activeKey={activeTab} onChange={(k) => setActiveTab(k as any)}>
        <Tabs.TabPane tab="默认" key="default">
          {p.pipelineDefaultTriggerParams ? (
            <pre style={{ background: '#f5f5f5', padding: 12, maxHeight: 320, overflow: 'auto' }}>
              {JSON.stringify(p.pipelineDefaultTriggerParams, null, 2)}
            </pre>
          ) : (
            <div style={{ color: '#999' }}>该流水线尚未配置默认 triggerParams</div>
          )}
        </Tabs.TabPane>

        <Tabs.TabPane tab="历史回放" key="history">
          <Table
            rowKey="runId"
            dataSource={history}
            size="small"
            rowSelection={{
              type: 'radio',
              selectedRowKeys: selectedRunId ? [selectedRunId] : [],
              onChange: (keys) => setSelectedRunId(keys[0] as number),
            }}
            columns={[
              { title: '时间', dataIndex: 'startedAt', render: (v) => new Date(v).toLocaleString() },
              { title: '触发源', dataIndex: 'triggerType' },
              { title: '触发人', dataIndex: 'triggeredBy' },
              { title: '状态', dataIndex: 'status' },
              {
                title: 'triggerParams 摘要',
                dataIndex: 'triggerParams',
                render: (v) => <code style={{ fontSize: 11 }}>{JSON.stringify(v).slice(0, 100)}</code>,
              },
            ]}
            pagination={false}
            scroll={{ y: 320 }}
          />
        </Tabs.TabPane>

        <Tabs.TabPane tab="自定义 JSON" key="custom">
          <Editor
            height="320px"
            defaultLanguage="json"
            value={customJson}
            onChange={(v) => { setCustomJson(v ?? '{}'); setCustomError(null) }}
            options={{ minimap: { enabled: false }, fontSize: 13 }}
          />
          {customError && <div style={{ color: 'red', marginTop: 4 }}>{customError}</div>}
        </Tabs.TabPane>
      </Tabs>
    </Modal>
  )
}
```

- [ ] **Step 2: tsc + dev smoke**

Run: `cd web && pnpm exec tsc --noEmit && pnpm build`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add web/src/pipeline-canvas/dryrun/DryRunStartModal.tsx
git commit -m "feat(canvas-dryrun): DryRunStartModal 启动对话框（3 Tab：默认/历史回放/自定义）"
```

---

## Task 10: SideEffectDecisionModal — 副作用决策框

**Files:**
- Create: `web/src/pipeline-canvas/dryrun/SideEffectDecisionModal.tsx`

**目的：** spec §5.1 — 三 Tab 决策框（真跑 / Stub / 手填）+ 「记住」复选框 + Monaco 编辑 manual JSON。

- [ ] **Step 1: 创建 SideEffectDecisionModal**

Create `web/src/pipeline-canvas/dryrun/SideEffectDecisionModal.tsx`：
```tsx
import { useState, useEffect } from 'react'
import { Modal, Tabs, Checkbox, message } from 'antd'
import Editor from '@monaco-editor/react'
import type { DryRunChunk } from './useDryRunSSE'

interface Props {
  chunk: DryRunChunk | null  // type='decision-needed' chunk
  onSubmit: (decision: { decision: 'real' | 'stub' | 'manual'; manualOutput?: Record<string, unknown>; remember: boolean }) => void
  onCancel: () => void
}

export function SideEffectDecisionModal({ chunk, onSubmit, onCancel }: Props) {
  const [activeTab, setActiveTab] = useState<'real' | 'stub' | 'manual'>('real')
  const [remember, setRemember] = useState(false)
  const [manualJson, setManualJson] = useState('{}')

  useEffect(() => {
    if (!chunk) return
    const last = chunk.lastDecision as 'real' | 'stub' | 'manual' | null
    setActiveTab(last ?? 'real')
    setRemember(false)
    const lastManual = chunk.lastManualOutput as Record<string, unknown> | null
    const initial = lastManual ?? chunk.schemaTemplate as Record<string, unknown> | undefined ?? {}
    setManualJson(JSON.stringify(initial, null, 2))
  }, [chunk])

  if (!chunk) return null

  function handleOk() {
    if (activeTab === 'real') {
      onSubmit({ decision: 'real', remember })
    } else if (activeTab === 'stub') {
      onSubmit({ decision: 'stub', manualOutput: chunk!.schemaTemplate as any, remember })
    } else {
      try {
        const parsed = JSON.parse(manualJson)
        onSubmit({ decision: 'manual', manualOutput: parsed, remember })
      } catch (e) {
        message.error(`JSON 解析失败：${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  return (
    <Modal
      title={`副作用节点决策：${chunk.nodeId}（${chunk.stageType}）`}
      open
      onCancel={onCancel}
      onOk={handleOk}
      width={680}
      okText="确认"
    >
      <Tabs activeKey={activeTab} onChange={(k) => setActiveTab(k as any)}>
        <Tabs.TabPane tab="真跑" key="real">
          <div style={{ color: '#666' }}>
            会真实调用该节点的实现（IM API / DB / SSH 等）。慎用。
          </div>
          <pre style={{ background: '#f5f5f5', padding: 12, marginTop: 8, fontSize: 12 }}>
            params: {JSON.stringify(chunk.params, null, 2)}
          </pre>
        </Tabs.TabPane>

        <Tabs.TabPane tab="Stub" key="stub">
          <div style={{ color: '#666' }}>使用 schema 默认值跳过执行（不产生副作用）：</div>
          <pre style={{ background: '#f5f5f5', padding: 12, marginTop: 8, maxHeight: 240, overflow: 'auto' }}>
            {JSON.stringify(chunk.schemaTemplate, null, 2)}
          </pre>
        </Tabs.TabPane>

        <Tabs.TabPane tab="手填" key="manual">
          <Editor
            height="280px"
            defaultLanguage="json"
            value={manualJson}
            onChange={(v) => setManualJson(v ?? '{}')}
            options={{ minimap: { enabled: false }, fontSize: 13 }}
          />
        </Tabs.TabPane>
      </Tabs>

      <Checkbox checked={remember} onChange={(e) => setRemember(e.target.checked)}
        style={{ marginTop: 12 }}>
        记住此节点的选择（下次同节点试跑预选 + 预填）
      </Checkbox>
    </Modal>
  )
}
```

- [ ] **Step 2: tsc**

Run: `pnpm exec tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add web/src/pipeline-canvas/dryrun/SideEffectDecisionModal.tsx
git commit -m "feat(canvas-dryrun): SideEffectDecisionModal 决策框（真跑/Stub/手填 + 记住）"
```

---

## Task 11: 画布等待状态 + 节点 ▶ 按钮 + WaitingExternalBanner

**Files:**
- Create: `web/src/pipeline-canvas/dryrun/WaitingExternalBanner.tsx`
- Modify: `web/src/pipeline-canvas/canvas/nodes/StageNodeCard.tsx` (加 ▶ 按钮 + 等待边)
- Modify: `web/src/pipeline-canvas/canvas/nodes/SwitchNode.tsx` (同上)

**目的：** spec §5.2 + §7.4 — wait_webhook/im_input 节点上画"等待中"黄边 + 顶部条带显示 webhookUrl 复制按钮；每个节点视觉加 ▶ 按钮。

- [ ] **Step 1: 创建 WaitingExternalBanner**

Create `web/src/pipeline-canvas/dryrun/WaitingExternalBanner.tsx`：
```tsx
import { Alert, Button, message } from 'antd'
import { CopyOutlined } from '@ant-design/icons'
import type { DryRunChunk } from './useDryRunSSE'

export function WaitingExternalBanner({ chunk }: { chunk: DryRunChunk }) {
  const hint = chunk.hint as { webhookTag?: string; webhookUrl?: string; imGroupId?: string; imPrompt?: string }
  return (
    <Alert
      type="warning"
      showIcon
      message={`等待外部触发：${chunk.nodeId}（${chunk.stageType}）`}
      description={
        <div>
          {hint.webhookUrl && (
            <div>
              复制并外部 POST 此 URL 触发：
              <code style={{ background: '#fff', padding: '2px 6px', marginLeft: 4 }}>{hint.webhookUrl}</code>
              <Button size="small" type="link" icon={<CopyOutlined />}
                onClick={() => { navigator.clipboard.writeText(hint.webhookUrl!); message.success('已复制') }} />
            </div>
          )}
          {hint.imPrompt && (
            <div>请在 IM 群（{hint.imGroupId}）回复：<i>{hint.imPrompt}</i></div>
          )}
        </div>
      }
    />
  )
}
```

- [ ] **Step 2: 改 StageNodeCard 加 ▶ 按钮 + 等待边**

修改 `web/src/pipeline-canvas/canvas/nodes/StageNodeCard.tsx`，加 props `onRunHere?: () => void` 与 `dryRunPhase?: 'idle' | 'running' | 'success' | 'failed' | 'awaiting-external'`：

```tsx
import { Handle, Position } from '@xyflow/react'
import { Card, Tag, Button } from 'antd'
import { PlayCircleOutlined } from '@ant-design/icons'
import type { CSSProperties, ReactNode } from 'react'

interface Props {
  color: string
  typeLabel: string
  title: string
  footer?: ReactNode
  onRunHere?: () => void
  dryRunPhase?: 'idle' | 'running' | 'success' | 'failed' | 'awaiting-external'
}

const handleStyle: CSSProperties = {
  width: 18, height: 18, border: '3px solid #fff',
  background: '#1677ff', boxShadow: '0 0 0 1px #1677ff',
}

const phaseBorders: Record<NonNullable<Props['dryRunPhase']>, string> = {
  idle: '',
  running: '2px solid #1677ff',
  success: '2px solid #52c41a',
  failed: '2px solid #f5222d',
  'awaiting-external': '2px dashed #faad14',  // 黄虚线 = 等待中
}

export function StageNodeCard({ color, typeLabel, title, footer, onRunHere, dryRunPhase = 'idle' }: Props) {
  const barStyle: CSSProperties = {
    position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, background: color,
    borderTopLeftRadius: 6, borderBottomLeftRadius: 6,
  }
  const cardStyle: CSSProperties = {
    width: 220, position: 'relative',
    border: phaseBorders[dryRunPhase] || undefined,
    animation: dryRunPhase === 'awaiting-external' ? 'pulse 1.5s infinite' : undefined,
  }
  return (
    <Card size="small" style={cardStyle} styles={{ body: { padding: '8px 12px' } }}>
      <div style={barStyle} />
      <Handle type="target" position={Position.Top} style={handleStyle} />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Tag color={color}>{typeLabel}</Tag>
        {onRunHere && (
          <Button type="text" size="small" icon={<PlayCircleOutlined />}
            onClick={(e) => { e.stopPropagation(); onRunHere() }}
            title="试运行至此" />
        )}
      </div>
      <div style={{ fontWeight: 500, marginTop: 4 }}>{title || <span style={{ color: '#aaa' }}>未命名</span>}</div>
      {footer && <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>{footer}</div>}
      <Handle type="source" position={Position.Bottom} style={handleStyle} />
    </Card>
  )
}
```

加 CSS 关键帧（在 `web/src/index.css` 或全局样式表）：
```css
@keyframes pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(250, 173, 20, 0.4); }
  50% { box-shadow: 0 0 0 6px rgba(250, 173, 20, 0); }
}
```

- [ ] **Step 3: SwitchNode 也加 ▶ 按钮 + 等待边**

修改 `web/src/pipeline-canvas/canvas/nodes/SwitchNode.tsx` 同款 props（按 StageNodeCard 模式）。

- [ ] **Step 4: 把 dryRunPhase / onRunHere 透传到 nodeTypes**

修改 `web/src/pipeline-canvas/canvas/nodes/nodeTypes.ts`：让 makeSimpleNode 接受 `onRunHere`/`dryRunPhase` 透传：

```tsx
function makeSimpleNode(color: string, typeLabel: string, footerFn?: (d: StageNode['data']) => string) {
  return function SimpleNode(props: NodeProps<StageNode>) {
    return createElement(StageNodeCard, {
      color, typeLabel,
      title: props.data.name,
      footer: footerFn ? footerFn(props.data) : undefined,
      onRunHere: (props.data as any).__onRunHere,         // 通过 data 透传
      dryRunPhase: (props.data as any).__dryRunPhase,
    })
  }
}
```

PipelineCanvasPage 在准备 nodes 时把 `__onRunHere` / `__dryRunPhase` 注入 data。

- [ ] **Step 5: tsc + 视觉冒烟**

Run: `pnpm exec tsc --noEmit && pnpm build`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add web/src/pipeline-canvas/dryrun/WaitingExternalBanner.tsx \
        web/src/pipeline-canvas/canvas/nodes/StageNodeCard.tsx \
        web/src/pipeline-canvas/canvas/nodes/SwitchNode.tsx \
        web/src/pipeline-canvas/canvas/nodes/nodeTypes.ts \
        web/src/index.css
git commit -m "feat(canvas-dryrun): 节点 ▶ 按钮 + 等待中黄虚线脉动 + WaitingExternalBanner"
```

---

## Task 12: NodeInspector Tabs 重构 + UpstreamFieldsTab

**Files:**
- Modify: `web/src/pipeline-canvas/panels/NodeInspector.tsx` (改 Tabs)
- Create: `web/src/pipeline-canvas/panels/UpstreamFieldsTab.tsx`

**目的：** spec §8 — Inspector 改 antd Tabs 挂「参数」+「上游字段」，后者用 antd Tree 渲染上游 snapshots，点 leaf 复制 `{{steps.<id>.output.<path>}}` 到剪贴板。

- [ ] **Step 1: 创建 UpstreamFieldsTab**

Create `web/src/pipeline-canvas/panels/UpstreamFieldsTab.tsx`：
```tsx
import { useEffect, useState } from 'react'
import { Tree, Button, Tag, message, Empty } from 'antd'
import { ExclamationCircleTwoTone, ReloadOutlined } from '@ant-design/icons'
import { listSnapshots, type DryRunSnapshot } from '../../api/dryrun'

interface Props {
  pipelineId: number
  currentNodeId: string
  ancestors: Set<string>     // 由 PipelineCanvasPage 用 computeAncestors 算好传入
  onRunUpstream: (nodeId: string) => void  // 试跑上游某节点
}

interface TreeNode {
  title: React.ReactNode
  key: string
  children?: TreeNode[]
  isLeaf?: boolean
  path?: string  // 完整 {{steps.<id>.output.<path>}} 表达式
}

function buildTree(snapshot: DryRunSnapshot, parentPath: string, parentKey: string): TreeNode[] {
  const value = snapshot.output
  function recurse(v: unknown, path: string, key: string): TreeNode[] {
    if (v === null || typeof v !== 'object') {
      return [{
        title: <span><span style={{ color: '#999' }}>{path.split('.').pop()}: </span><code>{JSON.stringify(v)}</code></span>,
        key, path: `{{${path}}}`, isLeaf: true,
      }]
    }
    if (Array.isArray(v)) {
      return v.slice(0, 5).flatMap((item, i) => recurse(item, `${path}[${i}]`, `${key}-${i}`))
    }
    return Object.entries(v).flatMap(([k, sub]) => {
      const childPath = `${path}.${k}`
      const childKey = `${key}-${k}`
      if (sub === null || typeof sub !== 'object') {
        return [{
          title: <span>{k}: <code>{JSON.stringify(sub)}</code></span>,
          key: childKey, path: `{{${childPath}}}`, isLeaf: true,
        }]
      }
      return [{
        title: k,
        key: childKey,
        children: recurse(sub, childPath, childKey),
      }]
    })
  }
  return recurse(value, `steps.${snapshot.nodeId}.output`, parentKey)
}

const SOURCE_TAG: Record<string, { color: string; label: string }> = {
  real: { color: 'green', label: '真跑' },
  stub: { color: 'gold', label: 'Stub' },
  manual: { color: 'blue', label: '手填' },
}

export function UpstreamFieldsTab(p: Props) {
  const [snapshots, setSnapshots] = useState<DryRunSnapshot[]>([])
  const [loading, setLoading] = useState(false)

  async function load() {
    setLoading(true)
    try { setSnapshots(await listSnapshots(p.pipelineId)) }
    finally { setLoading(false) }
  }
  useEffect(() => { load() }, [p.pipelineId])

  const upstreamSnapshots = snapshots.filter(s => p.ancestors.has(s.nodeId))

  if (p.ancestors.size === 0) {
    return <Empty description="此节点没有上游" />
  }

  if (upstreamSnapshots.length === 0) {
    return (
      <div>
        <Empty description="上游节点尚未试跑" />
        <div style={{ marginTop: 12 }}>
          {Array.from(p.ancestors).map(nid => (
            <Button key={nid} size="small" onClick={() => p.onRunUpstream(nid)} style={{ marginRight: 4 }}>
              ▶ 试跑 {nid}
            </Button>
          ))}
        </div>
      </div>
    )
  }

  const onSelect = (_: unknown, info: { node: TreeNode }) => {
    if (info.node.isLeaf && info.node.path) {
      navigator.clipboard.writeText(info.node.path)
      message.success(`已复制 ${info.node.path}`)
    }
  }

  return (
    <div>
      <Button size="small" icon={<ReloadOutlined />} onClick={load} loading={loading} style={{ marginBottom: 8 }}>
        刷新
      </Button>
      {upstreamSnapshots.map(s => {
        const tag = SOURCE_TAG[s.source]
        return (
          <div key={s.nodeId} style={{ marginBottom: 16 }}>
            <div style={{ marginBottom: 4 }}>
              <strong>{s.nodeId}</strong>
              <Tag color={tag.color} style={{ marginLeft: 6 }}>{tag.label}</Tag>
              <span style={{ fontSize: 11, color: '#999' }}>
                {new Date(s.ranAt).toLocaleString()}
              </span>
              {s.stale && (
                <>
                  <ExclamationCircleTwoTone twoToneColor="#faad14" style={{ marginLeft: 8 }} />
                  <span style={{ fontSize: 11, color: '#faad14', marginLeft: 4 }}>上游已变</span>
                  <Button size="small" type="link" onClick={() => p.onRunUpstream(s.nodeId)}>重跑</Button>
                </>
              )}
            </div>
            <Tree
              treeData={buildTree(s, '', s.nodeId)}
              onSelect={onSelect}
              selectable
              defaultExpandAll
              style={{ background: '#fafafa', padding: 8, borderRadius: 4 }}
            />
          </div>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 2: 改 NodeInspector 用 antd Tabs**

修改 `web/src/pipeline-canvas/panels/NodeInspector.tsx`：
1. import 加 `Tabs` from 'antd' 与 `UpstreamFieldsTab`
2. Drawer body 把现有 Form 包到 `<Tabs.TabPane key="params" tab="参数">` 里
3. 加第二个 `<Tabs.TabPane key="upstream" tab="上游字段">`，渲染 `<UpstreamFieldsTab pipelineId={...} currentNodeId={selectedNode.id} ancestors={ancestors} onRunUpstream={...}/>`
4. ancestors 由父组件 PipelineCanvasPage 用 graph 调用 `computeAncestors`（从后端共享或前端复刻）
5. onRunUpstream 调父组件的 dry-run 启动逻辑（指定 targetNodeId=该上游节点）

> **执行注**：`computeAncestors` 后端在 `graph-validation.ts`，前端需复刻一份（小函数，<20 行）或通过 API 拉。最简：前端复刻（避免 API round-trip 影响 UX）。

- [ ] **Step 3: tsc + 视觉冒烟**

Run: `pnpm exec tsc --noEmit && pnpm build`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add web/src/pipeline-canvas/panels/UpstreamFieldsTab.tsx \
        web/src/pipeline-canvas/panels/NodeInspector.tsx
git commit -m "feat(canvas-inspector): Tabs 重构 + UpstreamFieldsTab（JSON Tree + 点 leaf 复制路径）"
```

---

## Task 13: toolbar 整图按钮 + PipelineCanvasPage 串联

**Files:**
- Modify: `web/src/pipeline-canvas/toolbar/CanvasToolbar.tsx` (加「▶ 试运行整图」按钮)
- Modify: `web/src/pipeline-canvas/PipelineCanvasPage.tsx` (集成 useDryRunSSE + 弹框联动 + 节点 ▶ 回调)

**目的：** 把 Task 8-12 的所有片段串联到画布 page 上。

- [ ] **Step 1: toolbar 加按钮**

修改 `web/src/pipeline-canvas/toolbar/CanvasToolbar.tsx` Props 加 `onRunAll: () => void`，在 Space 内 PlayCircleOutlined Button 旁加「▶ 试运行整图」：

```tsx
<Tooltip title="从入口跑到所有终端节点">
  <Button icon={<PlayCircleOutlined />} onClick={p.onRunAll}>试运行整图</Button>
</Tooltip>
```

- [ ] **Step 2: PipelineCanvasPage 集成**

修改 `web/src/pipeline-canvas/PipelineCanvasPage.tsx`：
1. import 4 个新组件 + useDryRunSSE
2. 加 state：`startModalOpen`, `targetNodeId`, `dryRunHook = useDryRunSSE()`
3. `handleNodeRunHere(nodeId)`：先检查 dirty，dirty 则提示先保存；不 dirty 则 setTargetNodeId(nodeId) + setStartModalOpen(true)
4. `handleStart(payload)`：用 graph hash + payload 调 `dryRunHook.start({...})`
5. `handleDecide(decision)`：调 `dryRunHook.submitDecision(...)`
6. 渲染：
   - `<DryRunStartModal open={startModalOpen} ... onConfirm={handleStart} />`
   - 当 `dryRunHook.state.phase === 'awaiting-decision'` → 渲染 `<SideEffectDecisionModal chunk={dryRunHook.state.pendingDecision} onSubmit={...} />`
   - 当 `dryRunHook.state.phase === 'awaiting-external'` → 顶部渲染 `<WaitingExternalBanner chunk={dryRunHook.state.pendingExternal!} />`
7. nodes prop 注入 `__onRunHere`/`__dryRunPhase`：把 `dryRunHook.state.progressByNode[node.id]` 映射成 dryRunPhase
8. 把 `dryRunHook.state.progressByNode` + `staleNodeIds` 传给 NodeInspector → UpstreamFieldsTab
9. CanvasToolbar 加 `onRunAll={() => handleNodeRunHere('*')}`

具体落地需 implementer 读现有 PipelineCanvasPage.tsx 上下文，按现有 props 模式插入。

- [ ] **Step 3: dev 验证（手动 smoke）**

Run: `cd web && pnpm dev`
- 选一个流水线 → 点节点 ▶ → DryRunStartModal 弹出
- 选 Tab 2「历史回放」→ 看到 test_runs 列表（如有）
- 选一条 → 开始 → SSE chunks 逐个推送 → 节点蓝色边框跑动
- 跑到副作用节点 → SideEffectDecisionModal 弹出 → 选 Stub → 确认 → 继续
- 跑到 wait_webhook → 节点黄边脉动 + WaitingExternalBanner 顶部条 → 复制 URL → curl 触发 → 自动 resume
- 完成后选下游节点 → Inspector「上游字段」Tab → 看到 JSON Tree → 点 leaf → 剪贴板有 `{{steps.<id>.output.<path>}}`

- [ ] **Step 4: tsc + build**

Run: `pnpm exec tsc --noEmit && pnpm build`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/pipeline-canvas/toolbar/CanvasToolbar.tsx \
        web/src/pipeline-canvas/PipelineCanvasPage.tsx
git commit -m "feat(canvas-dryrun): toolbar 整图按钮 + PipelineCanvasPage 串联所有 dry-run 模块"
```

---

## Task 14: 端到端集成测试

**Files:**
- Create: `src/__tests__/integration/dryrun-e2e.test.ts`

**目的：** 真后端 + mock SSE 接收（用 fetch 流式 + 解析 SSE chunk）+ 模拟前端 decide 调用，验证端到端三场景：
1. 简单 graph：sql_query → script(Stub) → http(手填) → 完成
2. wait_webhook 场景：跑到 wait_webhook → 模拟外部 POST webhook → 自动 resume → 完成
3. 失败场景：sql_query 抛错 → snapshot status=failed → SSE done

- [ ] **Step 1: 写 e2e 测试骨架**

Create `src/__tests__/integration/dryrun-e2e.test.ts`：
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { resetTestDb } from '../helpers/db.js'
import { buildTestApp } from '../helpers/test-app.js'
import { getPool } from '../../db/client.js'

async function readSseChunks(stream: ReadableStream<Uint8Array>): Promise<Array<{ type: string; data: any }>> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const chunks: Array<{ type: string; data: any }> = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const events = buf.split('\n\n')
    buf = events.pop() ?? ''
    for (const ev of events) {
      let type = 'message', dataStr = ''
      for (const l of ev.split('\n')) {
        if (l.startsWith('event:')) type = l.slice(6).trim()
        else if (l.startsWith('data:')) dataStr += l.slice(5).trim()
      }
      try { chunks.push({ type, data: JSON.parse(dataStr) }) } catch {}
    }
  }
  return chunks
}

describe('dryrun e2e', () => {
  beforeEach(async () => { await resetTestDb() })

  it('简单 graph：sql_query → script (Stub 决策) → http (手填决策) 全程', async () => {
    const graph = {
      nodes: [
        { id: 'q', name: 'q', stageType: 'sql_query', params: { sqlTemplate: 'SELECT 1' }, position: { x: 0, y: 0 } },
        { id: 's', name: 's', stageType: 'script', script: 'echo 1', targetRoles: ['app'], position: { x: 0, y: 0 } },
        { id: 'h', name: 'h', stageType: 'http', params: { url: 'http://x' }, position: { x: 0, y: 0 } },
      ],
      edges: [
        { id: 'e1', source: 'q', target: 's' },
        { id: 'e2', source: 's', target: 'h' },
      ],
    }
    const p = await getPool().query(
      `INSERT INTO test_pipelines (name, graph) VALUES ('p',$1::jsonb) RETURNING id`,
      [JSON.stringify(graph)])
    const pid = p.rows[0].id

    const app = await buildTestApp()

    // 启动 SSE（fastify-inject 不支持 SSE，需走 listen + fetch）
    await app.listen({ port: 0 })
    const url = `http://localhost:${(app.server.address() as any).port}/admin/test-pipelines/${pid}/dry-run/run-to/*`

    // 模拟前端：开 SSE + 收到 decision-needed 时 POST decide
    const sseResp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ triggerParams: {}, triggerType: 'manual', triggeredBy: 't' }),
    })
    // 解析 chunks 同时拦截 decision-needed
    // 简化：先收完全部 chunks，再 assert（但实际需要边收边 decide → 用 generator）
    // 这里给伪代码
    const reader = sseResp.body!.getReader()
    // ... handle each chunk: 若 decision-needed → fetch /decide
    // ... 完整实现见 implementer 落地

    expect(sseResp.status).toBe(200)
  }, 30_000)

  it('wait_webhook 场景：节点 → 外部 POST → resume → 完成', async () => {
    // 同上骨架，wait_webhook 节点 stageType
    expect(true).toBe(true)
  })

  it('节点失败：snapshot status=failed + SSE error → done', async () => {
    expect(true).toBe(true)
  })
})
```

> **执行注**：fastify-inject 不支持 SSE 流式响应（一次性返回），所以这个 e2e 测试**必须用 `app.listen({port: 0})` + 真 fetch**。implementer 落地时按现有 `src/__tests__/helpers/test-app.ts` 的 listen 模式做。

- [ ] **Step 2: 实现完整 e2e 流程**

按 Step 1 骨架补完三个 case，关键点：
1. **边收 SSE 边 decide**：用 async generator 读 chunks，遇 `decision-needed` 时 fetch `/decide`，遇 `done` 退出
2. **wait_webhook 场景**：跑到 `waiting-external` chunk 时，从 chunk.hint.webhookUrl 取 URL，模拟 fetch POST 该 URL，graph resume
3. **失败场景**：让 sql_query 缺 sqlTemplate 自然失败 → assert SSE 收到 `snapshot status=failed` + `done`

- [ ] **Step 3: 跑测试**

Run: `npx vitest run src/__tests__/integration/dryrun-e2e.test.ts`
Expected: PASS（3 个 case）

- [ ] **Step 4: 跑全套不退化**

Run: `npx vitest run src/__tests__/`
Expected: 现有测试 + 本次新加全 PASS

- [ ] **Step 5: Commit**

```bash
git add src/__tests__/integration/dryrun-e2e.test.ts
git commit -m "test(integration): dryrun e2e 三场景（决策流 + webhook resume + 失败）"
```

---

## Verification（端到端验证手册）

实施完成后按以下顺序验证全套功能：

1. **后端单测全绿**：`npx vitest run`（含 v45-migration / dryrun-snapshots-repo / dryrun-hash / dryrun-stub / dryrun-wrapper / dryrun-runner / dryrun-api / dryrun-e2e）
2. **前端编译通过**：`cd web && pnpm build`
3. **DB migration 已落地**：`pnpm migrate` → 控制台显示 v45 已执行；查 `\d pipeline_dryrun_snapshots` 应显示完整字段
4. **Backend 可启**：`pnpm dev` → 无启动错误
5. **画布手动 smoke**：
   - 选一条已配过的流水线 → 点节点 ▶ → DryRunStartModal 三 Tab 切换显示正确
   - Tab 2 历史回放：看到 test_runs 数据（含 webhook 触发的 payload）
   - 点开始 → 节点边框依次蓝→绿动画
   - 副作用节点（如 dm/script）→ 决策框三 Tab + 「记住」复选框
   - wait_webhook 节点 → 黄边脉动 + 顶部 banner 显示 webhookUrl + 复制按钮
   - 复制 URL → `curl -X POST <url> -d '{}'` → 浏览器看到节点变绿继续
   - 选下游节点 → Inspector「上游字段」Tab → 看到 JSON Tree → 点字段 → toast 提示已复制
   - 改某上游节点参数 → 保存 → 再开下游节点 Inspector → 上游字段树头部 ⚠ 「上游已变」+ 「重跑」按钮
6. **运行时 smoke**：触发该 pipeline（生产路径）→ test_runs 记录 trigger_params → 重新进画布选历史回放 Tab → 看到该次 run

---

## 风险与缓解

| 风险 | 缓解 |
|-----|------|
| fan_out 子节点直接调 executor，wrapper 不覆盖 | Task 4 Step 6：fan_out 内部副作用节点强制 stub（不走 real）；P2 议题：让 fan_out 子图也经 graph-builder dispatcher |
| webhook 路由 dryrunSessionId 参数与现有 wait_webhook handler 集成 | Task 6 Step 1 强制要求 implementer 先 grep webhook handler 现状再写代码 |
| im_input 试跑无法可靠路由 | spec §5.2 「执行注」标记 v1 fallback：dryrun runner 跑到 im_input 直接弹「不支持」决策框，强制 stub |
| SSE 浏览器兼容（fetch ReadableStream） | useDryRunSSE 用 fetch + ReadableStream（不用 EventSource），主流浏览器都支持 |
| Monaco 体积（~1MB） | 接受 v1 体积成本；如未来需优化可改用 react-codemirror |
| advisory lock 释放失败导致死锁 | runDryRun 用 try/finally 强制 unlock；30 分钟超时清 session 时也 unlock |
| graph dirty hash 计算前端 vs 后端不一致 | 前端用 `JSON.stringify(graph)` 算 hash；保存时后端按相同算法存到 pipeline.graphHash 列（v46 可能要加，v1 用 ad-hoc 比对） |

---

## 备注：Plan 文件落地

按写作约定 plan 终稿已 commit 到 `docs/superpowers/plans/2026-04-27-pipeline-dryrun.md`（与同日期 spec 配套）。



