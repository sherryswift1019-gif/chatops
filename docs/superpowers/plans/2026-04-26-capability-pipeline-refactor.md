# 能力(Capability)与流水线(Pipeline)分工重构 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 capability/pipeline 分工重构成四层抽象（触发器层 / pipeline / pipeline_node_types / capabilities），并把 6 处硬编码字典与 3 个内部 handler 迁到 DB 配置 + pipeline DAG。

**Architecture:** 双表物理分离 + 半开放节点注册制 + 点记法 DSL + 双轨 feature flag 迁移。详见 spec [§2 整体架构](../specs/2026-04-26-capability-pipeline-refactor-design.md#2-整体架构)。

**Tech Stack:** TypeScript (ES2022, NodeNext), Fastify 5, PostgreSQL 16 (pg driver, raw SQL, 无 ORM), React 18 + Ant Design 5, Vitest, LangGraph (现有 graph-runner 基建).

**Spec:** [`docs/superpowers/specs/2026-04-26-capability-pipeline-refactor-design.md`](../specs/2026-04-26-capability-pipeline-refactor-design.md)

---

## 总览：5 阶段路线图

| 阶段 | 范围 | 周期 | 本 plan 覆盖度 |
|---|---|---|---|
| **阶段 0** | pipeline_node_types 表 + registry + 现有 5 种 stage 迁入注册制 | 1-2 周 | **完整 TDD 任务（本 plan §A）** |
| **阶段 1** | capabilities 表瘦身 + 4 处硬编码（写锁/worktree/maxTurns/timeout）改读 DB | 3-5 天 | outline（本 plan §B），完成阶段 0 后另写 sub-plan |
| **阶段 2** | im_triggers 表 + 路由层重构 + 剩余 2 处硬编码（FAILURE_MSGS/examples）+ 前端 P0 改造 | 1-2 周 | outline（本 plan §C） |
| **阶段 3** | DSL 增强（7 种新节点类型 + retry_when + fan_out + 表达式解析器 + 前端 P1 画布） | 2-3 周 | outline（本 plan §D） |
| **阶段 4** | 3 个 handler 迁移（L1→L2→L3 + feature flag 双轨灰度） | 3-4 周 | outline（本 plan §E） |

**为什么本 plan 只详细到阶段 0**：阶段 1-4 的具体任务粒度依赖于阶段 0 实现产生的真实形态（如 NodeExecutor interface 最终签名、registry 启动一致性检查的具体 API、节点 paramSchema 表达约定）。阶段 0 完成 → 重启 writing-plans 生成阶段 1 sub-plan，依此类推。

**衔接关键约束**：
- 阶段 1 的 capabilities ALTER ADD 与 §C 的 ALTER DROP **必须是不同 PR**（先 ADD + 数据 backfill + 代码下线读旧字段，最后 DROP）
- 阶段 2 的 `approval_rules.capability_key` 改名 `im_trigger_key` 必须在 im_triggers 表创建并填充种子数据**之后**（外键依赖）
- 阶段 3 的新节点类型 INSERT INTO pipeline_node_types **必须**伴随对应 TS executor 注册，否则启动一致性检查报错（§A 任务 4 实现）
- 阶段 4 任意时刻 `PIPELINE_DAG_HANDLERS=""` 即回退，不依赖 DB 状态

---

## 执行前提

- [ ] **Worktree 检查**：本 plan 设计在 worktree 中执行。当前若在 main 分支，建议先：
  ```bash
  git worktree add -b refactor/capability-pipeline ../chatops-refactor main
  cd ../chatops-refactor
  ```
- [ ] **依赖检查**：`pnpm install` 通过；`pnpm test` 现有用例全绿；`pnpm migrate` 跑通到 v29

---

# §A 阶段 0：pipeline_node_types 注册基础设施

**目标**：建立节点类型注册表（DB 元数据 + 代码 executor 注册中心），把现有 5 种 stage type（script/approval/capability/wait_webhook/im_input）迁入注册制，前端节点选择器从 API 取数据。完成后**现有 pipeline 行为零变化**，但所有后续阶段的扩展点都已就绪。

## 阶段 0 文件清单

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/db/schema-v30.sql` | 创建 | 新建 `pipeline_node_types` 表 + 5 条种子数据 |
| `src/db/migrate.ts` | 修改 | 追加 v30 执行块 |
| `src/db/repositories/pipeline-node-types.ts` | 创建 | repository: list / get / listEnabled |
| `src/__tests__/unit/pipeline-node-types-repo.test.ts` | 创建 | repository 单测 |
| `src/pipeline/node-types/registry.ts` | 创建 | 全局 registry: registerNodeType / getRegisteredNodeTypeKeys / getExecutor |
| `src/pipeline/node-types/types.ts` | 创建 | NodeExecutor interface / ExecutionContext type |
| `src/pipeline/node-types/index.ts` | 创建 | barrel: import 所有 executor 触发自注册 |
| `src/pipeline/node-types/script.ts` | 创建 | 把现有 script stage executor 包装为 NodeExecutor |
| `src/pipeline/node-types/approval.ts` | 创建 | 把现有 approval stage 包装 |
| `src/pipeline/node-types/capability.ts` | 创建 | 把现有 capability stage 包装（v1 沿用 stageType='capability'，阶段 3 改名为 llm_agent） |
| `src/pipeline/node-types/wait-webhook.ts` | 创建 | 包装 |
| `src/pipeline/node-types/im-input.ts` | 创建 | 包装 |
| `src/__tests__/unit/node-type-registry.test.ts` | 创建 | registry 注册/查询/一致性检查 |
| `src/server.ts` | 修改 | 启动时调一致性检查 |
| `src/admin/routes/pipeline-node-types.ts` | 创建 | GET /admin/pipeline-node-types 列表 API |
| `src/admin/index.ts` | 修改 | 注册新路由 |
| `src/__tests__/unit/admin-pipeline-node-types-route.test.ts` | 创建 | 路由数据形态单测 |
| `web/src/api/pipelineNodeTypes.ts` | 创建 | 前端 API client |
| `web/src/types/pipelineNodeType.ts` | 创建 | 前端类型定义 |
| `web/src/pipeline-canvas/panels/NodeInspector.tsx` | 修改 | 节点选择器从 API 取数据 |
| `docs/smoke-pipeline-node-types.md` | 创建 | 阶段 0 冒烟手册 |

---

## 阶段 0 / Task 1: 新增 schema-v30 + repository

**Files:**
- Create: `src/db/schema-v30.sql`
- Modify: `src/db/migrate.ts`
- Create: `src/db/repositories/pipeline-node-types.ts`
- Create: `src/__tests__/unit/pipeline-node-types-repo.test.ts`

- [ ] **Step 1: 创建 schema 文件**

Create `src/db/schema-v30.sql`:

```sql
-- v30: pipeline_node_types 节点类型注册表
-- 节点类型元信息在 DB（display_name / param_schema / output_schema），
-- 执行器在代码（src/pipeline/node-types/<key>.ts 通过 registerNodeType() 注册）。
-- 启动时一致性检查：DB enabled 行 ↔ 代码 register 调用必须一致。

CREATE TABLE IF NOT EXISTS pipeline_node_types (
  key             TEXT PRIMARY KEY,
  display_name    TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  category        TEXT NOT NULL CHECK (category IN ('general','flow','llm','specialized')),
  param_schema    JSONB NOT NULL DEFAULT '{}',
  output_schema   JSONB NOT NULL DEFAULT '{}',
  is_system       BOOLEAN NOT NULL DEFAULT TRUE,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 种子数据：现有 5 种 stage type 迁入注册表
-- v1 仅做"注册"，不改变 pipeline 引擎行为；阶段 3 才会扩展节点类型
INSERT INTO pipeline_node_types (key, display_name, description, category, param_schema, output_schema)
VALUES
  ('script', 'SSH 脚本', 'SSH 远程脚本执行', 'general',
    '{"type":"object","properties":{"commands":{"type":"string","format":"textarea"},"script":{"type":"string"},"targetServers":{"type":"array","items":{"type":"string"}}}}'::jsonb,
    '{"type":"object","properties":{"exitCode":{"type":"number"},"stdout":{"type":"string"},"stderr":{"type":"string"}}}'::jsonb),
  ('approval', '人工审批', '人工审批节点（IM 卡片或 Web 按钮）', 'flow',
    '{"type":"object","properties":{"approverIds":{"type":"array","items":{"type":"string"}},"approverIdsResolver":{"type":"string"},"approvalDescription":{"type":"string","format":"textarea"}}}'::jsonb,
    '{"type":"object","properties":{"decision":{"type":"string","enum":["approved","rejected","timeout"]},"approver":{"type":"string"},"comment":{"type":"string"}}}'::jsonb),
  ('capability', 'LLM Agent (capability)', '触发某 capability 的 LLM agent 节点', 'llm',
    '{"type":"object","properties":{"capabilityKey":{"type":"string","x-source":"capabilities"},"capabilityParams":{"type":"object"}}}'::jsonb,
    '{"type":"object","properties":{"text":{"type":"string"}}}'::jsonb),
  ('wait_webhook', '等待 webhook', '等外部 webhook 回调', 'flow',
    '{"type":"object","properties":{"webhookTag":{"type":"string"},"timeoutSeconds":{"type":"number"}}}'::jsonb,
    '{"type":"object","properties":{"payload":{"type":"object"}}}'::jsonb),
  ('im_input', 'IM 参数采集', '通过 IM 多轮对话采集参数', 'flow',
    '{"type":"object","properties":{"prompt":{"type":"string"},"paramSchema":{"type":"object"},"capabilityKey":{"type":"string","x-source":"capabilities"}}}'::jsonb,
    '{"type":"object","properties":{"runtimeVars":{"type":"object"}}}'::jsonb)
ON CONFLICT (key) DO NOTHING;
```

- [ ] **Step 2: 在 migrate.ts 追加 v30 执行块**

Edit `src/db/migrate.ts`，在末尾 v29 之后追加：

```typescript
const schemaV30 = readFileSync(join(__dirname, 'schema-v30.sql'), 'utf8')
await pool.query(schemaV30)
console.log('[migrate] schema-v30 applied')
```

并把文件末尾的"已应用版本"日志（grep 找最新 console.log 行）更新为包含 `v30 + pipeline_node_types`。

- [ ] **Step 3: 写 repository 单测（先失败）**

Create `src/__tests__/unit/pipeline-node-types-repo.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getPool, closePool } from '../../db/client.js'
import { listNodeTypes, getNodeType, listEnabledNodeTypeKeys } from '../../db/repositories/pipeline-node-types.js'
import { runMigrations } from '../../db/migrate.js'

describe('pipeline-node-types repository', () => {
  beforeAll(async () => { await runMigrations() })
  afterAll(async () => { await closePool() })

  it('lists all 5 seeded node types', async () => {
    const types = await listNodeTypes()
    const keys = types.map(t => t.key).sort()
    expect(keys).toEqual(['approval','capability','im_input','script','wait_webhook'])
  })

  it('getNodeType returns null for unknown key', async () => {
    expect(await getNodeType('nonexistent')).toBeNull()
  })

  it('getNodeType returns parsed param_schema as object', async () => {
    const t = await getNodeType('script')
    expect(t).not.toBeNull()
    expect(typeof t!.paramSchema).toBe('object')
    expect(t!.category).toBe('general')
  })

  it('listEnabledNodeTypeKeys returns enabled-only set', async () => {
    const keys = await listEnabledNodeTypeKeys()
    expect(keys.size).toBe(5)
    expect(keys.has('script')).toBe(true)
  })
})
```

Run: `pnpm test src/__tests__/unit/pipeline-node-types-repo.test.ts`
Expected: FAIL with `cannot find module '../../db/repositories/pipeline-node-types.js'`

- [ ] **Step 4: 实现 repository**

Create `src/db/repositories/pipeline-node-types.ts`:

```typescript
import { getPool } from '../client.js'

export interface PipelineNodeType {
  key: string
  displayName: string
  description: string
  category: 'general' | 'flow' | 'llm' | 'specialized'
  paramSchema: Record<string, unknown>
  outputSchema: Record<string, unknown>
  isSystem: boolean
  enabled: boolean
  createdAt: Date
  updatedAt: Date
}

function mapRow(r: Record<string, unknown>): PipelineNodeType {
  return {
    key: r.key as string,
    displayName: r.display_name as string,
    description: (r.description ?? '') as string,
    category: r.category as PipelineNodeType['category'],
    paramSchema: (r.param_schema ?? {}) as Record<string, unknown>,
    outputSchema: (r.output_schema ?? {}) as Record<string, unknown>,
    isSystem: r.is_system as boolean,
    enabled: r.enabled as boolean,
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
  }
}

export async function listNodeTypes(): Promise<PipelineNodeType[]> {
  const { rows } = await getPool().query('SELECT * FROM pipeline_node_types ORDER BY category, key')
  return rows.map(mapRow)
}

export async function getNodeType(key: string): Promise<PipelineNodeType | null> {
  const { rows } = await getPool().query('SELECT * FROM pipeline_node_types WHERE key = $1', [key])
  return rows[0] ? mapRow(rows[0]) : null
}

export async function listEnabledNodeTypeKeys(): Promise<Set<string>> {
  const { rows } = await getPool().query('SELECT key FROM pipeline_node_types WHERE enabled = true')
  return new Set(rows.map(r => r.key as string))
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm test src/__tests__/unit/pipeline-node-types-repo.test.ts`
Expected: 4 PASS

- [ ] **Step 6: 跑迁移确认 SQL 语法**

Run: `pnpm migrate`
Expected: 输出包含 `[migrate] schema-v30 applied`

- [ ] **Step 7: Commit**

```bash
git add src/db/schema-v30.sql src/db/migrate.ts \
        src/db/repositories/pipeline-node-types.ts \
        src/__tests__/unit/pipeline-node-types-repo.test.ts
git commit -m "feat(db): pipeline_node_types 表 + repository（schema-v30）"
```

---

## 阶段 0 / Task 2: NodeExecutor interface + registry 骨架

**Files:**
- Create: `src/pipeline/node-types/types.ts`
- Create: `src/pipeline/node-types/registry.ts`
- Create: `src/__tests__/unit/node-type-registry.test.ts`

- [ ] **Step 1: 写 registry 单测（先失败）**

Create `src/__tests__/unit/node-type-registry.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import {
  registerNodeType,
  getRegisteredNodeTypeKeys,
  getExecutor,
  __resetRegistryForTesting,
  assertRegistryConsistent,
} from '../../pipeline/node-types/registry.js'
import type { NodeExecutor, ExecutionContext } from '../../pipeline/node-types/types.js'

describe('node-type registry', () => {
  beforeEach(() => { __resetRegistryForTesting() })

  it('registers and looks up executor by key', () => {
    const dummy: NodeExecutor = {
      key: 'dummy',
      async execute(_params, _ctx) { return { status: 'success', output: { ok: true } } },
    }
    registerNodeType(dummy)
    expect(getRegisteredNodeTypeKeys()).toEqual(new Set(['dummy']))
    expect(getExecutor('dummy')).toBe(dummy)
  })

  it('throws on duplicate registration', () => {
    const a: NodeExecutor = { key: 'x', async execute() { return { status: 'success', output: {} } } }
    registerNodeType(a)
    expect(() => registerNodeType(a)).toThrow(/already registered/)
  })

  it('assertRegistryConsistent reports DB-only and code-only diffs', () => {
    registerNodeType({ key: 'a', async execute() { return { status: 'success', output: {} } } })
    expect(() => assertRegistryConsistent(new Set(['a','b']))).toThrow(/DB only.*b/)
    expect(() => assertRegistryConsistent(new Set([]))).toThrow(/Code only.*a/)
    expect(() => assertRegistryConsistent(new Set(['a']))).not.toThrow()
  })
})
```

Run: `pnpm test src/__tests__/unit/node-type-registry.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 2: 实现 types.ts**

Create `src/pipeline/node-types/types.ts`:

```typescript
import type { TaskContext } from '../../agent/tools/types.js'

/** 节点执行结果 —— pipeline 引擎据此决定 retryWhen / 边 when / 下游是否激活 */
export interface NodeExecutionResult {
  status: 'success' | 'failed' | 'skipped'
  output: Record<string, unknown>
  error?: string
}

/** 执行上下文 —— 节点 executor 拿到的所有运行时信息 */
export interface ExecutionContext {
  runId: number
  pipelineId: number
  nodeId: string
  triggerParams: Record<string, unknown>
  vars: Record<string, unknown>
  /** 已执行节点的输出，按 nodeId 索引 */
  steps: Record<string, { status: 'success' | 'failed' | 'skipped'; output: Record<string, unknown> }>
  /** fan_out 注入的局部变量（阶段 3 才会非空） */
  scopes?: Record<string, Record<string, unknown>>
  /** 当前节点的目标服务器（script stage 等用） */
  server?: { host: string; port: number; username: string }
  /** 透传给 capability stage 的 TaskContext */
  taskContext?: TaskContext
}

export interface NodeExecutor {
  key: string
  /** v1：直接 async；阶段 3 fan_out 节点需要扩展为支持子图调度 */
  execute(params: Record<string, unknown>, ctx: ExecutionContext): Promise<NodeExecutionResult>
}
```

- [ ] **Step 3: 实现 registry.ts**

Create `src/pipeline/node-types/registry.ts`:

```typescript
import type { NodeExecutor } from './types.js'

const registry = new Map<string, NodeExecutor>()

export function registerNodeType(executor: NodeExecutor): void {
  if (registry.has(executor.key)) {
    throw new Error(`node type "${executor.key}" already registered`)
  }
  registry.set(executor.key, executor)
}

export function getExecutor(key: string): NodeExecutor | undefined {
  return registry.get(key)
}

export function getRegisteredNodeTypeKeys(): Set<string> {
  return new Set(registry.keys())
}

/**
 * 启动一致性检查：DB enabled 的 node type 必须跟代码 register 一一对应。
 * 漂移时抛错，防止"DB 有但代码没实现"或"代码注册了但 DB 没添加"。
 */
export function assertRegistryConsistent(dbEnabledKeys: Set<string>): void {
  const codeKeys = getRegisteredNodeTypeKeys()
  const dbOnly = [...dbEnabledKeys].filter(k => !codeKeys.has(k))
  const codeOnly = [...codeKeys].filter(k => !dbEnabledKeys.has(k))
  if (dbOnly.length || codeOnly.length) {
    const msg = [
      'Node type registry mismatch:',
      dbOnly.length ? `  DB only: ${dbOnly.join(', ')}` : '',
      codeOnly.length ? `  Code only: ${codeOnly.join(', ')}` : '',
    ].filter(Boolean).join('\n')
    throw new Error(msg)
  }
}

/** 仅供单测用 —— 清空 registry */
export function __resetRegistryForTesting(): void {
  registry.clear()
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/__tests__/unit/node-type-registry.test.ts`
Expected: 3 PASS

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/node-types/types.ts \
        src/pipeline/node-types/registry.ts \
        src/__tests__/unit/node-type-registry.test.ts
git commit -m "feat(pipeline): NodeExecutor interface + 全局 registry"
```

---

## 阶段 0 / Task 3: 把 5 种现有 stage 包装为 NodeExecutor

**目标**：每种现有 stage type 创建一个 `src/pipeline/node-types/<key>.ts` 文件，里面调 `registerNodeType()` 自注册。**v1 阶段 0 这些 executor 是空壳**——它们的 execute 方法实际上把工作委托回 `graph-builder.ts` 已有的 stage 处理逻辑（不改变 pipeline 引擎实际行为）。阶段 3 才会让 graph-runner 真正调 NodeExecutor.execute。

**为什么阶段 0 是空壳**：节点类型注册基础设施 + 现有 5 种行为零变化是阶段 0 的硬约束。真正的执行接管在阶段 3 与新节点类型一起做，避免阶段 0 同时改两件事造成回归不可控。

**Files:**
- Create: `src/pipeline/node-types/script.ts`
- Create: `src/pipeline/node-types/approval.ts`
- Create: `src/pipeline/node-types/capability.ts`
- Create: `src/pipeline/node-types/wait-webhook.ts`
- Create: `src/pipeline/node-types/im-input.ts`
- Create: `src/pipeline/node-types/index.ts`

- [ ] **Step 1: 创建 script.ts（空壳示范）**

Create `src/pipeline/node-types/script.ts`:

```typescript
import { registerNodeType } from './registry.js'

/**
 * v1 阶段 0：空壳注册——execute 永不被调用。
 * pipeline 实际执行仍在 graph-builder.ts 走原 stage handler。
 * 阶段 3 该 executor 才会被 graph-runner 真正调用。
 */
registerNodeType({
  key: 'script',
  async execute() {
    throw new Error('script executor not invoked in phase 0; routed via graph-builder')
  },
})
```

- [ ] **Step 2: 创建另外 4 个空壳**

Create `src/pipeline/node-types/approval.ts`、`capability.ts`、`wait-webhook.ts`、`im-input.ts`，每个文件内容相同结构（key 不同）。

- [ ] **Step 3: 创建 barrel 触发自注册**

Create `src/pipeline/node-types/index.ts`:

```typescript
// 触发自注册 —— 任何模块 import 此 barrel 都会让 5 种 node type 注册到 registry
import './script.js'
import './approval.js'
import './capability.js'
import './wait-webhook.js'
import './im-input.js'

export * from './registry.js'
export * from './types.js'
```

- [ ] **Step 4: 写集成测试验证 barrel 注册**

Edit `src/__tests__/unit/node-type-registry.test.ts`，追加：

```typescript
describe('node-type barrel', () => {
  it('registers all 5 stage types when index is imported', async () => {
    __resetRegistryForTesting()
    // 动态 import barrel 触发自注册
    await import('../../pipeline/node-types/index.js')
    const keys = getRegisteredNodeTypeKeys()
    expect(keys).toEqual(new Set(['script','approval','capability','wait_webhook','im_input']))
  })
})
```

Run: `pnpm test src/__tests__/unit/node-type-registry.test.ts`
Expected: 4 PASS

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/node-types/
git commit -m "feat(pipeline): 5 种现有 stage 包装为 NodeExecutor 自注册（v1 空壳）"
```

---

## 阶段 0 / Task 4: server 启动时跑一致性检查

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: 找到 server 启动初始化位置**

Run: `grep -n "registerTool\|migrate\|listen" src/server.ts | head -20`
找到适合的初始化点（一般在 import 自注册 + DB 连接之后、`server.listen()` 之前）。

- [ ] **Step 2: 注入一致性检查**

Edit `src/server.ts`，在 import 段加入：

```typescript
import './pipeline/node-types/index.js'  // 触发 5 种 node type 自注册
import { assertRegistryConsistent } from './pipeline/node-types/registry.js'
import { listEnabledNodeTypeKeys } from './db/repositories/pipeline-node-types.js'
```

在 `server.listen()` 之前（DB 连接已就绪后），加入：

```typescript
// 节点类型注册一致性检查 —— DB enabled 行 ↔ 代码 register 必须一致
const dbEnabledKeys = await listEnabledNodeTypeKeys()
assertRegistryConsistent(dbEnabledKeys)
console.log(`[server] node-type registry verified: ${dbEnabledKeys.size} types`)
```

- [ ] **Step 3: 启动 server 验证一致性检查通过**

Run: `pnpm dev`
Expected: 启动日志包含 `node-type registry verified: 5 types`，无报错。

Stop server (Ctrl+C) once you see the line.

- [ ] **Step 4: 故意制造漂移验证报错（手测）**

临时把 schema-v30.sql 的 `script` 改名为 `script_x` 然后重跑 migrate（或在数据库里手动 `UPDATE pipeline_node_types SET enabled=false WHERE key='script'`），重启 server，预期：
```
Error: Node type registry mismatch:
  Code only: script
```
验证后**还原**（UPDATE enabled=true 或 schema 文件还原）。

- [ ] **Step 5: Commit**

```bash
git add src/server.ts
git commit -m "feat(pipeline): server 启动时校验 node-type registry 一致性"
```

---

## 阶段 0 / Task 5: GET /admin/pipeline-node-types API

**Files:**
- Create: `src/admin/routes/pipeline-node-types.ts`
- Modify: `src/admin/index.ts`
- Create: `src/__tests__/unit/admin-pipeline-node-types-route.test.ts`

**测试风格说明**：本仓库现有集成测试（`src/__tests__/integration/`）主要靠 `resetTestDb()` + 直接调内部模块，不用 Fastify inject。所以这里 API 路由用 **单元测试 + 路由 handler 直调** 的方式（同 admin 路由现有模式），完整 IM 链路由阶段 0 / Task 7 的冒烟手册手测覆盖。

- [ ] **Step 1: 实现路由**

Create `src/admin/routes/pipeline-node-types.ts`:

```typescript
import type { FastifyPluginAsync } from 'fastify'
import { listNodeTypes } from '../../db/repositories/pipeline-node-types.js'

export const pipelineNodeTypesRoutes: FastifyPluginAsync = async (app) => {
  app.get('/admin/pipeline-node-types', async (_req, _reply) => {
    const items = await listNodeTypes()
    return { items: items.filter(t => t.enabled) }
  })
}
```

Edit `src/admin/index.ts`, 在路由注册段加：

```typescript
import { pipelineNodeTypesRoutes } from './routes/pipeline-node-types.js'
// ...
await app.register(pipelineNodeTypesRoutes)
```

- [ ] **Step 2: 写单元测试（直接调 listNodeTypes，不通过 Fastify）**

Create `src/__tests__/unit/admin-pipeline-node-types-route.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetTestDb } from '../helpers/db.js'
import { closePool } from '../../db/client.js'
import { listNodeTypes } from '../../db/repositories/pipeline-node-types.js'

describe('admin /pipeline-node-types data shape', () => {
  beforeAll(async () => { await resetTestDb() })
  afterAll(async () => { await closePool() })

  it('returns 5 enabled types covering 3 categories', async () => {
    const items = (await listNodeTypes()).filter(t => t.enabled)
    expect(items).toHaveLength(5)
    const byCategory = new Map<string, number>()
    for (const t of items) byCategory.set(t.category, (byCategory.get(t.category) ?? 0) + 1)
    expect(byCategory.get('general')).toBe(1)   // script
    expect(byCategory.get('flow')).toBe(3)      // approval / wait_webhook / im_input
    expect(byCategory.get('llm')).toBe(1)       // capability
  })

  it('paramSchema is parsed object on every type', async () => {
    const items = await listNodeTypes()
    for (const t of items) {
      expect(typeof t.paramSchema).toBe('object')
      expect(t.paramSchema).not.toBeNull()
    }
  })
})
```

Run: `pnpm test src/__tests__/unit/admin-pipeline-node-types-route.test.ts`
Expected: 2 PASS

- [ ] **Step 3: 启动 server 手测 endpoint**

Run: `pnpm dev`，新开 terminal:

```bash
curl -s http://localhost:3000/admin/pipeline-node-types | python3 -m json.tool
```

Expected：JSON `{"items":[ ... ]}` 共 5 项，每项含 key/displayName/category/paramSchema/outputSchema 字段。

- [ ] **Step 4: Commit**

```bash
git add src/admin/routes/pipeline-node-types.ts src/admin/index.ts \
        src/__tests__/unit/admin-pipeline-node-types-route.test.ts
git commit -m "feat(admin): GET /admin/pipeline-node-types API"
```

---

## 阶段 0 / Task 6: 前端节点选择器从 API 取数据

**Files:**
- Create: `web/src/api/pipelineNodeTypes.ts`
- Create: `web/src/types/pipelineNodeType.ts`
- Modify: `web/src/pipeline-canvas/panels/NodeInspector.tsx`

**注意**：本任务只切换"节点类型选择器"的数据源，**不改节点参数表单**（参数表单仍按现有 stageType-specific 字段渲染，不走 paramSchema 动态渲染——那是阶段 3 §D 的事）。这样阶段 0 改动可控。

- [ ] **Step 1: 创建前端类型**

Create `web/src/types/pipelineNodeType.ts`:

```typescript
export interface PipelineNodeType {
  key: string
  displayName: string
  description: string
  category: 'general' | 'flow' | 'llm' | 'specialized'
  paramSchema: Record<string, unknown>
  outputSchema: Record<string, unknown>
  enabled: boolean
}
```

- [ ] **Step 2: 创建 API client**

Create `web/src/api/pipelineNodeTypes.ts`:

```typescript
import axios from 'axios'
import type { PipelineNodeType } from '../types/pipelineNodeType.js'

export async function listPipelineNodeTypes(): Promise<PipelineNodeType[]> {
  const { data } = await axios.get<{ items: PipelineNodeType[] }>('/admin/pipeline-node-types')
  return data.items
}
```

- [ ] **Step 3: 改 NodeInspector 节点选择器**

Read 现有 `web/src/pipeline-canvas/panels/NodeInspector.tsx` 找到硬编码的 stageType 选择器位置（典型为 Select 组件 options 写死 5 种枚举）。

替换硬编码 options 为 useEffect 拉 API + state，按 category 分组渲染（用 `Select.OptGroup`）：

```typescript
import { useEffect, useState } from 'react'
import { Select } from 'antd'
import { listPipelineNodeTypes } from '../../api/pipelineNodeTypes'
import type { PipelineNodeType } from '../../types/pipelineNodeType'

const CATEGORY_LABELS: Record<string, string> = {
  general: '通用',
  flow: '流程',
  llm: 'LLM',
  specialized: '业务',
}

// 在组件内：
const [nodeTypes, setNodeTypes] = useState<PipelineNodeType[]>([])
useEffect(() => {
  listPipelineNodeTypes().then(setNodeTypes).catch(console.error)
}, [])

const grouped = nodeTypes.reduce<Record<string, PipelineNodeType[]>>((acc, t) => {
  (acc[t.category] ??= []).push(t)
  return acc
}, {})

// Select 部分：
<Select value={node.stageType} onChange={...}>
  {Object.entries(grouped).map(([cat, items]) => (
    <Select.OptGroup key={cat} label={CATEGORY_LABELS[cat] ?? cat}>
      {items.map(t => (
        <Select.Option key={t.key} value={t.key}>
          {t.displayName}
        </Select.Option>
      ))}
    </Select.OptGroup>
  ))}
</Select>
```

注意：v1 NodeInspector 的 `node.stageType` 字段名暂不动；阶段 2 / 阶段 3 会改为 `node.nodeTypeKey`。

- [ ] **Step 4: 浏览器手测**

Run:
```bash
cd web && pnpm dev
```
打开 `http://localhost:5173`，进入任意 pipeline 编辑器，新增/编辑节点。
Expected:
- 节点类型下拉显示 4 个分组（通用/流程/LLM/业务），其中"业务"为空
- 5 种节点类型都能选到，对应原 stageType 行为不变
- 浏览器 devtools Network 标签有 `GET /admin/pipeline-node-types` 200 响应

- [ ] **Step 5: 跑前端 build**

Run: `cd web && pnpm build`
Expected: TypeScript 类型检查通过 + Vite 构建成功

- [ ] **Step 6: Commit**

```bash
git add web/src/api/pipelineNodeTypes.ts \
        web/src/types/pipelineNodeType.ts \
        web/src/pipeline-canvas/panels/NodeInspector.tsx
git commit -m "feat(canvas): 节点选择器从 /admin/pipeline-node-types API 取数据"
```

---

## 阶段 0 / Task 7: 冒烟手册 + 阶段验收

**Files:**
- Create: `docs/smoke-pipeline-node-types.md`

- [ ] **Step 1: 编写冒烟手册**

Create `docs/smoke-pipeline-node-types.md`:

````markdown
# 冒烟：pipeline_node_types 注册基础设施（阶段 0）

## 验收清单

### 1. DB 状态
```bash
psql $DATABASE_URL -c "SELECT key, category, enabled FROM pipeline_node_types ORDER BY category, key;"
```
预期：5 行（script/approval/capability/wait_webhook/im_input），全部 enabled=t。

### 2. 启动日志
```bash
pnpm dev
```
预期日志包含：`[server] node-type registry verified: 5 types`。

### 3. 故意漂移
```sql
UPDATE pipeline_node_types SET enabled=false WHERE key='script';
```
重启 server，预期 throw `Node type registry mismatch: Code only: script`。

恢复：
```sql
UPDATE pipeline_node_types SET enabled=true WHERE key='script';
```

### 4. API
```bash
curl http://localhost:3000/admin/pipeline-node-types | jq '.items | length'
```
预期：`5`。

### 5. 前端
打开 pipeline 画布，新增节点 → 节点类型下拉 4 个分组、5 个选项。

### 6. 现有 pipeline 行为零变化
触发 schema-v19 的 deploy-im-demo pipeline，跑通 IM 入口 → im_input → approval → capability 三阶段。

## 回滚
```sql
DROP TABLE IF EXISTS pipeline_node_types CASCADE;
```
（开发期，DROP 后 server 启动会因一致性检查失败 → 提示重跑 migrate）
````

- [ ] **Step 2: 执行冒烟全清单**

按手册第 1-6 步逐项手测，确保全绿。

- [ ] **Step 3: Commit**

```bash
git add docs/smoke-pipeline-node-types.md
git commit -m "docs(smoke): 阶段 0 冒烟手册"
```

---

## 阶段 0 Definition of Done

- [ ] schema-v30 已应用，5 行种子数据存在
- [ ] `pnpm test` 全绿（含新增 9 个用例）
- [ ] `pnpm dev` 启动一致性检查通过
- [ ] 故意漂移启动报错验证过
- [ ] `cd web && pnpm build` 通过
- [ ] `docs/smoke-pipeline-node-types.md` 6 项全绿
- [ ] 现有所有 pipeline 行为零回归（关键路径：IM-driven deploy / fix_bug 全链路）
- [ ] 已 commit 到 feature branch

阶段 0 完成后启动阶段 1 的 sub-plan 生成（重启 writing-plans skill，输入"基于阶段 0 实现产生的 NodeExecutor / registry API，生成阶段 1 capabilities 表瘦身的 sub-plan"）。

---

# §B 阶段 1 outline：capabilities 表瘦身（待 sub-plan）

**周期估算**：3-5 天

**核心任务**：

1. **schema-v31**：给 `capabilities` 表 ADD 4 字段（`max_turns INT DEFAULT 30` / `timeout_ms INT DEFAULT 1200000` / `requires_worktree BOOL DEFAULT FALSE` / `requires_deploy_lock BOOL DEFAULT FALSE`）+ backfill 现有行（CODE_CAPABILITIES 列出的设 requires_worktree=true，writeCapabilities 列出的设 requires_deploy_lock=true）
2. **capabilities repository 扩展**：mapRow 加 4 字段
3. **claude-runner 改造 1**：`writeCapabilities` Set 删除，改为查 capability.requires_deploy_lock
4. **claude-runner 改造 2**：`CODE_CAPABILITIES` 数组删除，改为查 capability.requires_worktree
5. **claude-runner 改造 3**：Porygon `defaults.maxTurns` / `defaults.timeoutMs` 改为按 capability 行覆盖
6. **集成测试**：deploy / fix_bug_l1 / analyze_bug 各跑一遍，对比新旧路径行为对等
7. **冒烟**：`docs/smoke-capabilities-cleanup.md`

**关键约束**：
- 4 个新字段 ADD 后**绝对不能马上 DROP 旧字段**（如 `default_pipeline_id`）；旧字段 DROP 必须放在阶段 2 完成后单独 PR
- backfill 数据正确性由 schema-v31.sql 末尾 `RAISE EXCEPTION` 断言保证（如 "fix_bug_l1 应当 requires_worktree=true"）

**待 sub-plan 决策点**（阶段 0 完成后回答）：
- NodeExecutor 接口形态最终如何（在阶段 0 实现中可能演化）
- repository 是否复用现有 capabilities.ts 加方法 vs 新建 capabilities-extended.ts
- 测试 fixture 怎么避免污染主 capabilities 表

---

# §C 阶段 2 outline：im_triggers 表 + 路由层重构（待 sub-plan）

**周期估算**：1-2 周

**核心任务**：

1. **schema-v32**：CREATE `im_triggers` + `product_line_im_triggers` 表（spec §3.1 / §3.2）；ALTER `approval_rules` RENAME `capability_key` → `im_trigger_key`
2. **数据迁移脚本（in-SQL）**：把入口类 capability 行（deploy / view_* / analyze_bug / search_knowledge / manage_role / prd_submit 等）的 metadata 写入 im_triggers，附 backfill 之前 ClaudeRunner 硬编码的 examples + FAILURE_MSGS 字典内容
3. **product_line_capabilities → product_line_im_triggers 数据复制**：保持双写过渡（旧表暂留，因后续 LLM agent 的产线 RBAC 还要用）
4. **im-triggers repository**：list / get / create / update / delete + checkAccess(plId, key, env, role, source)
5. **claude-runner 路由层重构**：detectIntent 输出空间从 capabilities 改读 im_triggers；权限校验改读 product_line_im_triggers；FAILURE_MSGS / CAP_NAMES / examples 字典删除，改为读 im_triggers 字段
6. **runner-greet-filter 改造**：源数据切换
7. **前端 P0**：拆 `CapabilitiesPage` → `IMTriggersPage` (新) + `CapabilitiesPage` (重构，仅 LLM agent 配置)；改 `ProductLineDetailPage` 能力管理 Tab；改 `ApprovalRulesPage` 字段名
8. **菜单与路由**：admin 菜单加 `IM 触发器` 项，原 `能力管理` 重命名为 `能力库`
9. **集成测试**：IM 群消息触发全链路（含 greet / detectIntent / 权限拒绝 / 入口审批）
10. **冒烟**：`docs/smoke-im-triggers.md`
11. **cleanup PR（独立）**：DROP COLUMN `capabilities.default_pipeline_id` / `category` / `param_schema` / `playbook` / `needs_approval`

**关键约束**：
- 任务 5 完成 + 集成测试全绿后，cleanup PR 才能 ship；否则旧字段被读但已删 → 启动失败
- approval_rules 改名要保护历史数据：`ALTER TABLE approval_rules RENAME COLUMN capability_key TO im_trigger_key` 同时更新所有 SQL 查询和 repository

---

# §D 阶段 3 outline：DSL 增强（待 sub-plan）

**周期估算**：2-3 周

**核心任务**：

1. **节点类型扩展（schema-v33 新增 7 行）**：http / dm / db_update / sql_query / file_read / fan_out / template_render
2. **NodeExecutor 实现 7 个**：每个一个 `src/pipeline/node-types/<key>.ts` 真正实现 + 单测
3. **graph-runner 接管 NodeExecutor.execute**：v1 阶段 0 的"空壳 routed via graph-builder"全面切走，graph-runner 直接调 executor.execute（这一步是阶段 3 的核心改造）
4. **变量插值器扩展**：[`src/pipeline/variables.ts`](../../src/pipeline/variables.ts) 加点记法子路径解析 + JSONPath 子集 + 内置过滤器（urlEncode / jsonStringify / lower / upper）
5. **表达式解析器**：手写 PEG/parser-combinator 解析 retry_when / shortCircuitWhen / 边 when（运算符 == != < <= > >= && || ! contains）
6. **fan_out 子运行调度器**：扩展 graph-runner 支持子图并行调度 + 输出聚合
7. **graph-validation 扩展**：fan_out body 校验 / retry_when 表达式预解析 / steps 引用 DFS 验证
8. **前端 P1**：节点参数表单 JSON Schema 驱动渲染（含 `x-source: capabilities` 下拉源）；retry / fan_out 高级配置 UI；NodeInspector 字段从 `node.stageType` 改为 `node.nodeTypeKey`（含 `capability` → `llm_agent` 重命名）
9. **重命名 `capability` 节点 → `llm_agent`**：DB UPDATE pipeline_node_types SET key='llm_agent' WHERE key='capability'；test_pipelines.graph 中 stageType='capability' 数据迁移；代码 src/pipeline/node-types/capability.ts → llm_agent.ts
10. **集成测试**：写一条 demo pipeline 串 http + dm + sql_query + fan_out 各节点，跑通
11. **冒烟**：`docs/smoke-pipeline-dsl.md`

**关键约束**：
- 任务 9 改名是破坏性变更，必须在 staging 全绿后再 ship
- fan_out 子运行调度器改动 graph-runner 核心，需要逐 case 回归现有 pipeline

---

# §E 阶段 4 outline：handler 迁移（待 sub-plan）

**周期估算**：3-4 周（L1 → L2 → L3 各一周灰度）

**核心任务**：

1. **schema-v34**：CREATE `internal_capability_pipelines` 表（spec §6.5）
2. **coordinator.triggerCapability 加 feature flag**：`PIPELINE_DAG_HANDLERS` 环境变量解析
3. **runPipelineAsCapability 实现**：把 pipeline 跑结果封装回 `TriggerResult`
4. **L1：request_handover pipeline 定义** —— 4 节点 DAG（spec §6.2）
5. **L1 行为对等测试**：构造 reportId fixture，handler 路径 vs pipeline 路径双跑对比 bug_fix_events 写入 + GitLab outbound（nock）
6. **L1 灰度上线**：`PIPELINE_DAG_HANDLERS=request_handover`
7. **L1 冒烟**：`docs/smoke-handler-migration-handover.md`
8. **L2：notify_bug pipeline 定义** —— scenario 多分支 DAG（spec §6.3）
9. **L2 行为对等测试 + 灰度 + 冒烟**
10. **L3：create_mr pipeline 定义** —— 多 project fan_out + 主从分支 DAG（spec §6.4）
11. **L3 行为对等测试 + 灰度 + 冒烟**
12. **删除旧 handler**：稳定 1-2 周后删 [`mr-handler.ts`](../../src/agent/mr/mr-handler.ts) / [`notify-handler.ts`](../../src/agent/notify/notify-handler.ts) / [`request-handover-handler.ts`](../../src/agent/handover/request-handover-handler.ts)
13. **删除过渡表**：`DROP TABLE internal_capability_pipelines`（feature flag 永久打开后）

**关键约束**：
- 任意一步异常 → `PIPELINE_DAG_HANDLERS=""` 即回滚到 handler 路径，无 DB 状态变化
- 每个 L 各自的"行为对等测试"覆盖 success + 所有 failure 路径
- L3 依赖阶段 3 的 fan_out + http + template_render 节点完整可用

---

## 巡检与索引

- 完整设计：[spec](../specs/2026-04-26-capability-pipeline-refactor-design.md)
- 阶段 0 进度：本 plan §A 任务 1-7
- 阶段 1-4 sub-plan 触发条件：见各阶段末尾"待 sub-plan 决策点"

每阶段 DoD 全部勾选后，**重启 writing-plans skill**生成下一阶段 sub-plan，输入示例：

> "阶段 0 已完成（合并到 main），基于实际形态生成阶段 1 sub-plan：capabilities 表瘦身 + 4 处硬编码改读 DB。已知约束：NodeExecutor interface 在 src/pipeline/node-types/types.ts；现有 capabilities repository 在 src/db/repositories/capabilities.ts。"
