# 流水线可视化编排画布 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 React Flow 自建 DAG 画布替代 `TestPipelinesPage` 的线性 Modal 表单，解锁 LangGraph runtime 已有的条件分支能力；旧表单保留作为退路。

**Architecture:** 新增 `test_pipelines.graph JSONB` 列存储 `PipelineGraph = { nodes, edges }`，`graph-builder` 按 edge.condition 组装 `addConditionalEdges`；前端新增 `web/src/pipeline-canvas/` 目录，基于 `@xyflow/react` 自建画布，新路由 `/pipelines/:id/canvas`；旧 stages 列保留作 fallback。

**Tech Stack:** PostgreSQL JSONB + Fastify 5 + LangGraph (`@langchain/langgraph`) + React 18 + Antd 5 + `@xyflow/react` v12 + `@dagrejs/dagre`；测试用 Vitest（后端）、dev server 手工验证（前端）。

**参考文档：** `docs/superpowers/specs/2026-04-21-pipeline-canvas-design.md`

---

## Phase A — 后端数据模型与 API

### Task 1: Schema v12 添加 graph 列

**Files:**
- Create: `src/db/schema-v12.sql`
- Modify: `src/db/migrate.ts` 追加 v12 执行

- [ ] **Step 1: 创建 schema-v12.sql**

```sql
-- schema-v12.sql: pipeline visual graph (DAG with conditional edges)

ALTER TABLE test_pipelines
  ADD COLUMN IF NOT EXISTS graph JSONB;

COMMENT ON COLUMN test_pipelines.graph IS
  'PipelineGraph { nodes, edges }. NULL 时 runtime 把 stages 列当作线性图读取。';
```

- [ ] **Step 2: 在 migrate.ts 追加 v12**

读取 `src/db/migrate.ts`，仿照 v11 的写法，追加一行执行 schema-v12.sql。保留原有顺序。

- [ ] **Step 3: 本地迁移 + 验证**

Run: `pnpm migrate`
Expected: 打印成功；`psql -c "\d test_pipelines" | grep graph` 返回 `graph | jsonb`

- [ ] **Step 4: Commit**

```bash
git add src/db/schema-v12.sql src/db/migrate.ts
git commit -m "feat(schema): 新增 test_pipelines.graph 列（可视化画布 DAG）"
```

---

### Task 2: PipelineGraph 类型定义

**Files:**
- Modify: `src/pipeline/types.ts` 追加 `PipelineNode` / `PipelineEdge` / `ConditionSpec` / `PipelineGraph`

- [ ] **Step 1: 追加类型定义**

在 `src/pipeline/types.ts` 末尾追加：

```ts
// ---- Visual canvas DAG model ---------------------------------------------
// StageDefinition 字段在节点内部复用；画布仅增加 id / position / edges。

export type ConditionSpec =
  | { kind: 'onSuccess' }
  | { kind: 'onFailure' }
  | { kind: 'expression'; expression: string }
// expression 首版只支持两种模板（详见 graph-builder conditionMatches）：
//   1. status == 'success' | 'failed' | 'skipped'
//   2. output.includes('...')

export interface PipelineNode extends StageDefinition {
  id: string                        // ULID
  position: { x: number; y: number }
}

export interface PipelineEdge {
  id: string                        // ULID
  source: string                    // PipelineNode.id
  target: string                    // PipelineNode.id
  condition?: ConditionSpec
}

export interface PipelineGraph {
  nodes: PipelineNode[]
  edges: PipelineEdge[]
}
```

- [ ] **Step 2: 类型检查通过**

Run: `pnpm tsc --noEmit`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add src/pipeline/types.ts
git commit -m "feat(pipeline): PipelineGraph/Node/Edge/ConditionSpec 类型"
```

---

### Task 3: linearizeStages 纯函数 + 测试

**Files:**
- Create: `src/pipeline/graph-migration.ts`
- Create: `src/__tests__/unit/graph-migration.test.ts`

- [ ] **Step 1: 先写测试**

创建 `src/__tests__/unit/graph-migration.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { linearizeStages } from '../../pipeline/graph-migration.js'
import type { StageDefinition } from '../../pipeline/types.js'

function makeStage(partial: Partial<StageDefinition> & Pick<StageDefinition, 'name' | 'stageType'>): StageDefinition {
  return {
    targetRoles: [], parallel: false, timeoutSeconds: 60,
    retryCount: 0, onFailure: 'stop', ...partial,
  }
}

describe('linearizeStages', () => {
  it('空数组返回空 graph', () => {
    const g = linearizeStages([])
    expect(g.nodes).toEqual([])
    expect(g.edges).toEqual([])
  })

  it('单 stage：一个 node、零 edge', () => {
    const g = linearizeStages([makeStage({ name: 'A', stageType: 'script', script: 'echo a' })])
    expect(g.nodes).toHaveLength(1)
    expect(g.nodes[0].name).toBe('A')
    expect(g.nodes[0].stageType).toBe('script')
    expect(g.nodes[0].id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)  // ULID
    expect(g.edges).toEqual([])
  })

  it('多 stage 串成线性链', () => {
    const g = linearizeStages([
      makeStage({ name: 'A', stageType: 'script' }),
      makeStage({ name: 'B', stageType: 'approval' }),
      makeStage({ name: 'C', stageType: 'script' }),
    ])
    expect(g.nodes).toHaveLength(3)
    expect(g.edges).toHaveLength(2)
    expect(g.edges[0].source).toBe(g.nodes[0].id)
    expect(g.edges[0].target).toBe(g.nodes[1].id)
    expect(g.edges[1].source).toBe(g.nodes[1].id)
    expect(g.edges[1].target).toBe(g.nodes[2].id)
    // 线性转换不产生条件边
    expect(g.edges[0].condition).toBeUndefined()
  })

  it('node.position 沿 y 递增', () => {
    const g = linearizeStages([
      makeStage({ name: 'A', stageType: 'script' }),
      makeStage({ name: 'B', stageType: 'script' }),
    ])
    expect(g.nodes[0].position.y).toBeLessThan(g.nodes[1].position.y)
  })

  it('保留 StageDefinition 所有字段', () => {
    const stage = makeStage({
      name: 'A', stageType: 'script', script: 'echo x',
      targetRoles: ['app'], parallel: true, timeoutSeconds: 120, retryCount: 2,
      onFailure: 'continue',
    })
    const g = linearizeStages([stage])
    expect(g.nodes[0]).toMatchObject({
      name: 'A', stageType: 'script', script: 'echo x',
      targetRoles: ['app'], parallel: true, timeoutSeconds: 120,
      retryCount: 2, onFailure: 'continue',
    })
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/__tests__/unit/graph-migration.test.ts`
Expected: FAIL — cannot find module `graph-migration`

- [ ] **Step 3: 实现 graph-migration.ts**

```ts
import { ulid } from 'ulidx'
import type { StageDefinition, PipelineGraph, PipelineNode, PipelineEdge } from './types.js'

/**
 * 把旧的 StageDefinition[] 转换为线性 PipelineGraph（纯函数）。
 * - 用于 graph IS NULL 时 repository 层的内存 fallback
 * - 也用于画布首次保存前的"打开即展示"
 * position.y 等差递增，x 固定，方便 dagre 后续接管。
 */
export function linearizeStages(stages: StageDefinition[]): PipelineGraph {
  const nodes: PipelineNode[] = stages.map((stage, i) => ({
    ...stage,
    id: ulid(),
    position: { x: 200, y: 100 + i * 120 },
  }))
  const edges: PipelineEdge[] = []
  for (let i = 0; i < nodes.length - 1; i++) {
    edges.push({ id: ulid(), source: nodes[i].id, target: nodes[i + 1].id })
  }
  return { nodes, edges }
}
```

- [ ] **Step 4: 安装 ulidx（若未安装）**

Run: `pnpm ls ulidx`
若无：`pnpm add ulidx`
Expected: 已安装 ulidx。

- [ ] **Step 5: 测试通过**

Run: `npx vitest run src/__tests__/unit/graph-migration.test.ts`
Expected: 所有 5 个测试 PASS。

- [ ] **Step 6: Commit**

```bash
git add src/pipeline/graph-migration.ts src/__tests__/unit/graph-migration.test.ts package.json pnpm-lock.yaml
git commit -m "feat(pipeline): linearizeStages 把旧 stages 转为线性 PipelineGraph"
```

---

### Task 4: 图静态校验 + 测试

**Files:**
- Create: `src/pipeline/graph-validation.ts`
- Create: `src/__tests__/unit/pipeline-graph-validation.test.ts`

- [ ] **Step 1: 先写测试**

```ts
import { describe, it, expect } from 'vitest'
import { validatePipelineGraph } from '../../pipeline/graph-validation.js'
import type { PipelineGraph } from '../../pipeline/types.js'

function node(id: string, name = id): PipelineGraph['nodes'][number] {
  return {
    id, name, stageType: 'script', script: 'true',
    targetRoles: [], parallel: false, timeoutSeconds: 60,
    retryCount: 0, onFailure: 'stop',
    position: { x: 0, y: 0 },
  }
}
function edge(id: string, source: string, target: string): PipelineGraph['edges'][number] {
  return { id, source, target }
}

describe('validatePipelineGraph', () => {
  it('空图视为合法（允许保存未完成的 draft）', () => {
    expect(validatePipelineGraph({ nodes: [], edges: [] }).ok).toBe(true)
  })

  it('单节点 + 0 边合法', () => {
    expect(validatePipelineGraph({ nodes: [node('a')], edges: [] }).ok).toBe(true)
  })

  it('线性链合法', () => {
    const g = { nodes: [node('a'), node('b'), node('c')], edges: [edge('e1', 'a', 'b'), edge('e2', 'b', 'c')] }
    expect(validatePipelineGraph(g).ok).toBe(true)
  })

  it('节点 id 重复：报错', () => {
    const g = { nodes: [node('a'), node('a', 'dup')], edges: [] }
    const r = validatePipelineGraph(g)
    expect(r.ok).toBe(false)
    expect(r.errors.some(e => e.includes('duplicate'))).toBe(true)
  })

  it('悬挂 edge（指向不存在节点）：报错', () => {
    const g = { nodes: [node('a')], edges: [edge('e1', 'a', 'ghost')] }
    const r = validatePipelineGraph(g)
    expect(r.ok).toBe(false)
    expect(r.errors.some(e => e.includes('ghost'))).toBe(true)
  })

  it('cycle：报错', () => {
    const g = {
      nodes: [node('a'), node('b'), node('c')],
      edges: [edge('e1', 'a', 'b'), edge('e2', 'b', 'c'), edge('e3', 'c', 'a')],
    }
    const r = validatePipelineGraph(g)
    expect(r.ok).toBe(false)
    expect(r.errors.some(e => e.toLowerCase().includes('cycle'))).toBe(true)
  })

  it('多个独立子图警告（不阻塞）：ok=true', () => {
    // 两个不连通的节点 —— 允许，因为画布编辑中途可能存在这种状态
    const g = { nodes: [node('a'), node('b')], edges: [] }
    expect(validatePipelineGraph(g).ok).toBe(true)
  })

  it('condition.kind=expression 需要非空 expression', () => {
    const g: PipelineGraph = {
      nodes: [node('a'), node('b')],
      edges: [{ id: 'e', source: 'a', target: 'b', condition: { kind: 'expression', expression: '' } }],
    }
    const r = validatePipelineGraph(g)
    expect(r.ok).toBe(false)
    expect(r.errors.some(e => e.includes('expression'))).toBe(true)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/__tests__/unit/pipeline-graph-validation.test.ts`
Expected: FAIL — cannot find module。

- [ ] **Step 3: 实现 graph-validation.ts**

```ts
import type { PipelineGraph } from './types.js'

export interface ValidationResult {
  ok: boolean
  errors: string[]
}

/**
 * 静态校验 PipelineGraph：
 *   - 节点 id 唯一
 *   - 所有 edge.source/target 指向已存在节点
 *   - 无 cycle（DFS 三色标记）
 *   - condition.kind === 'expression' 时 expression 非空
 * 允许：空图；多个不连通子图（画布编辑态）。
 */
export function validatePipelineGraph(graph: PipelineGraph): ValidationResult {
  const errors: string[] = []
  const nodeIds = new Set<string>()
  for (const n of graph.nodes) {
    if (nodeIds.has(n.id)) errors.push(`duplicate node id: ${n.id}`)
    nodeIds.add(n.id)
  }

  const adjacency = new Map<string, string[]>()
  for (const e of graph.edges) {
    if (!nodeIds.has(e.source)) errors.push(`edge ${e.id} source references missing node: ${e.source}`)
    if (!nodeIds.has(e.target)) errors.push(`edge ${e.id} target references missing node: ${e.target}`)
    if (e.condition?.kind === 'expression' && !e.condition.expression?.trim()) {
      errors.push(`edge ${e.id} condition.expression is empty`)
    }
    if (nodeIds.has(e.source) && nodeIds.has(e.target)) {
      const arr = adjacency.get(e.source) ?? []
      arr.push(e.target)
      adjacency.set(e.source, arr)
    }
  }

  // DFS cycle detection (white=0, gray=1, black=2)
  const color = new Map<string, 0 | 1 | 2>()
  for (const id of nodeIds) color.set(id, 0)
  function dfs(v: string): boolean {
    color.set(v, 1)
    for (const next of adjacency.get(v) ?? []) {
      const c = color.get(next)
      if (c === 1) return true        // gray → back-edge → cycle
      if (c === 0 && dfs(next)) return true
    }
    color.set(v, 2)
    return false
  }
  for (const id of nodeIds) {
    if (color.get(id) === 0 && dfs(id)) {
      errors.push('graph contains cycle')
      break
    }
  }

  return { ok: errors.length === 0, errors }
}
```

- [ ] **Step 4: 测试通过**

Run: `npx vitest run src/__tests__/unit/pipeline-graph-validation.test.ts`
Expected: 8 个测试全 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/graph-validation.ts src/__tests__/unit/pipeline-graph-validation.test.ts
git commit -m "feat(pipeline): validatePipelineGraph 静态校验（dup/悬挂/cycle/expression）"
```

---

### Task 5: graph-builder 支持 PipelineGraph 与条件边

**Files:**
- Modify: `src/pipeline/graph-builder.ts`
- Modify: `src/__tests__/unit/graph-builder.test.ts`

- [ ] **Step 1: 先写新测试（条件边路径）**

在 `src/__tests__/unit/graph-builder.test.ts` 末尾 describe 块追加：

```ts
import { buildGraphFromPipeline } from '../../pipeline/graph-builder.js'
import type { PipelineGraph } from '../../pipeline/types.js'

describe('buildGraphFromPipeline with conditional edges', () => {
  function makeNode(id: string, name: string, script = 'true'): PipelineGraph['nodes'][number] {
    return {
      id, name, stageType: 'script', script,
      targetRoles: [], parallel: false, timeoutSeconds: 60,
      retryCount: 0, onFailure: 'stop',
      position: { x: 0, y: 0 },
    }
  }

  it('onSuccess 走 A→B，failed 走 A→C', async () => {
    const a = makeNode('a', 'A')
    const b = makeNode('b', 'B')
    const c = makeNode('c', 'C')
    const graph: PipelineGraph = {
      nodes: [a, b, c],
      edges: [
        { id: 'e1', source: 'a', target: 'b', condition: { kind: 'onSuccess' } },
        { id: 'e2', source: 'a', target: 'c', condition: { kind: 'onFailure' } },
      ],
    }
    // hook: A 返回 success → 预期 B 执行、C 跳过
    const hooks: StageHooks = {
      async runScript(stage): Promise<StageExecutionResult> {
        if (stage.name === 'A') return { status: 'success', output: 'ok' }
        return { status: 'success', output: `${stage.name} ran` }
      },
      async runCapability() { return { status: 'success', output: '' } },
    }
    const builder = buildGraphFromPipeline({ graph, stageContext: baseCtx(), hooks })
    const app = builder.compile({ checkpointer: new MemorySaver() })
    const state = await app.invoke({}, { configurable: { thread_id: randomUUID() } })
    const names = state.stageResults.map((r: any) => r.name)
    expect(names).toContain('A')
    expect(names).toContain('B')
    expect(names).not.toContain('C')
  })

  it('expression 匹配 output.includes', async () => {
    const a = makeNode('a', 'A')
    const b = makeNode('b', 'B')
    const graph: PipelineGraph = {
      nodes: [a, b],
      edges: [{
        id: 'e1', source: 'a', target: 'b',
        condition: { kind: 'expression', expression: "output.includes('RETRY')" },
      }],
    }
    const hooks: StageHooks = {
      async runScript() { return { status: 'success', output: 'RETRY needed' } },
      async runCapability() { return { status: 'success', output: '' } },
    }
    const builder = buildGraphFromPipeline({ graph, stageContext: baseCtx(), hooks })
    const app = builder.compile({ checkpointer: new MemorySaver() })
    const state = await app.invoke({}, { configurable: { thread_id: randomUUID() } })
    expect(state.stageResults.map((r: any) => r.name)).toEqual(['A', 'B'])
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/__tests__/unit/graph-builder.test.ts -t "conditional edges"`
Expected: FAIL — `buildGraphFromPipeline` is not a function。

- [ ] **Step 3: 实现 buildGraphFromPipeline**

在 `src/pipeline/graph-builder.ts` 中追加（保留所有现有 export）：

```ts
// ---- New: build from PipelineGraph with conditional edges ----------------

import type { PipelineGraph, PipelineEdge, ConditionSpec } from './types.js'

export interface BuildPipelineGraphInput {
  graph: PipelineGraph
  stageContext: StageContextBase
  hooks: StageHooks
  triggerParams?: Record<string, unknown>
}

// safe expression evaluator. 只支持两种模板：
//   - status === 'success' | 'failed' | 'skipped'
//   - output.includes('...')
// 其它输入一律返回 false，避免 eval。
function conditionMatches(cond: ConditionSpec | undefined, result: StageResult): boolean {
  if (!cond) return true
  if (cond.kind === 'onSuccess') return result.status === 'success'
  if (cond.kind === 'onFailure') return result.status === 'failed'
  // expression
  const expr = cond.expression.trim()
  const statusMatch = expr.match(/^status\s*===\s*'(success|failed|skipped)'$/)
  if (statusMatch) return result.status === statusMatch[1]
  const outputMatch = expr.match(/^output\.includes\(['"]([^'"]+)['"]\)$/)
  if (outputMatch) return (result.output ?? '').includes(outputMatch[1])
  return false
}

function buildNodeName(node: PipelineGraph['nodes'][number], index: number): string {
  // 保持与旧 nodeName 一致的 `stage_<i>_<type>` 格式，便于日志兼容
  return nodeName(index, node)
}

export function buildGraphFromPipeline(input: BuildPipelineGraphInput) {
  const { graph, stageContext, hooks, triggerParams } = input
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let builder: any = new StateGraph(PipelineStateAnnotation)

  if (graph.nodes.length === 0) {
    builder = builder.addEdge(START, END)
    return builder as StateGraph<typeof PipelineStateAnnotation.State>
  }

  const idToIndex = new Map(graph.nodes.map((n, i) => [n.id, i]))
  const idToName = new Map(graph.nodes.map((n, i) => [n.id, buildNodeName(n, i)]))

  // addNode
  for (let i = 0; i < graph.nodes.length; i++) {
    const node = graph.nodes[i]
    const name = idToName.get(node.id)!
    switch (node.stageType) {
      case 'script':
        builder = builder.addNode(name, buildScriptNode(node, i, stageContext, hooks)); break
      case 'capability':
        builder = builder.addNode(name, buildCapabilityNode(node, i, stageContext, hooks, triggerParams)); break
      case 'approval':
        builder = builder.addNode(name, buildApprovalNode(node, i)); break
      case 'wait_webhook':
        builder = builder.addNode(name, buildWaitWebhookNode(node, i)); break
      default: {
        const unknown: never = node.stageType
        throw new Error(`Unsupported stage type: ${String(unknown)}`)
      }
    }
    builder = builder.addNode(skipRestName(i), buildSkipRestNode(graph.nodes, i + 1))
  }

  // entry: 第一个无入边的节点（多个时 LangGraph 只有一个 START，我们串联第一个）
  const hasIncoming = new Set(graph.edges.map(e => e.target))
  const entry = graph.nodes.find(n => !hasIncoming.has(n.id)) ?? graph.nodes[0]
  builder = builder.addEdge(START, idToName.get(entry.id)!)

  // 按 source 聚合出边
  const outBySource = new Map<string, PipelineEdge[]>()
  for (const e of graph.edges) {
    const arr = outBySource.get(e.source) ?? []
    arr.push(e)
    outBySource.set(e.source, arr)
  }

  for (let i = 0; i < graph.nodes.length; i++) {
    const node = graph.nodes[i]
    const name = idToName.get(node.id)!
    const skipName = skipRestName(i)
    const outs = outBySource.get(node.id) ?? []

    // 无出边 → addEdge(name, END)
    if (outs.length === 0) {
      builder = builder.addConditionalEdges(name, (state) => {
        const result = state.stageResults.find((r: StageResult) => r.name === node.name)
        if (result && shouldStopAfter(node, result)) return skipName
        return END
      }, { [END]: END, [skipName]: skipName })
      builder = builder.addEdge(skipName, END)
      continue
    }

    // 有出边 → 按 condition 路由
    const routeMap: Record<string, string> = { [skipName]: skipName, [END]: END }
    for (const e of outs) routeMap[idToName.get(e.target)!] = idToName.get(e.target)!

    builder = builder.addConditionalEdges(name, (state) => {
      const result = state.stageResults.find((r: StageResult) => r.name === node.name)
      if (!result) return idToName.get(outs[0].target) ?? END  // 防御性
      if (shouldStopAfter(node, result)) return skipName
      for (const e of outs) {
        if (conditionMatches(e.condition, result)) return idToName.get(e.target)!
      }
      return END  // 无匹配条件 → END
    }, routeMap)

    builder = builder.addEdge(skipName, END)
  }

  return builder as StateGraph<typeof PipelineStateAnnotation.State>
}
```

- [ ] **Step 4: 新测试通过 + 老测试未回归**

Run: `npx vitest run src/__tests__/unit/graph-builder.test.ts`
Expected: 新增 2 个测试 PASS；原有所有测试仍 PASS。

- [ ] **Step 5: 把旧 buildGraphFromStages 接到新入口（DRY）**

在 `buildGraphFromStages` 函数内部改为：

```ts
export function buildGraphFromStages(input: BuildGraphInput): ReturnType<typeof makeBuilder> {
  // 旧入口：把 stages 数组线性化后走新入口，避免双份逻辑。
  // 保持类型签名不变，内部转 PipelineGraph。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return buildGraphFromPipeline({
    graph: linearizeStagesForBuilder(input.stages),
    stageContext: input.stageContext,
    hooks: input.hooks,
    triggerParams: input.triggerParams,
  }) as any
}

// 独立一份、不依赖 ulidx，因为测试 fixture 用 stage.name 做 key；
// 与 graph-migration.linearizeStages 区别：这里 id 用 index，无须 ULID。
function linearizeStagesForBuilder(stages: StageDefinition[]) {
  const nodes = stages.map((s, i) => ({
    ...s, id: `n${i}`, position: { x: 0, y: i * 100 },
  }))
  const edges = []
  for (let i = 0; i < nodes.length - 1; i++) {
    edges.push({ id: `e${i}`, source: nodes[i].id, target: nodes[i + 1].id })
  }
  return { nodes, edges }
}
```

删除 `makeBuilder` 函数（被 `buildGraphFromPipeline` 替代）及其内部 `graph = ...` 构建链，只保留 `buildRouter` / `nodeName` / `skipRestName` / `shouldStopAfter` / 4 个 `buildXxxNode` / `buildSkipRestNode` 辅助函数。

- [ ] **Step 6: 所有 graph-builder 和 graph-runner 测试仍 PASS**

Run: `npx vitest run src/__tests__/unit/graph-builder.test.ts src/__tests__/unit/graph-runner.test.ts`
Expected: 全 PASS。

- [ ] **Step 7: Commit**

```bash
git add src/pipeline/graph-builder.ts src/__tests__/unit/graph-builder.test.ts
git commit -m "feat(pipeline): buildGraphFromPipeline 支持条件边；legacy stages 路径归一"
```

---

### Task 6: Repository 读写 graph 列

**Files:**
- Modify: `src/db/repositories/test-pipelines.ts`

- [ ] **Step 1: TestPipeline 接口增加 graph**

在 `TestPipeline` 接口追加：

```ts
graph: unknown | null   // PipelineGraph | null（NULL 表示 fallback 到 stages）
```

- [ ] **Step 2: mapRow 解析 graph**

```ts
graph: (r.graph ?? null) as unknown,
```

- [ ] **Step 3: create/update 接受 graph**

在 `createTestPipeline` 的 data 参数与 SQL 中追加 graph 列：

```ts
export async function createTestPipeline(data: {
  // ...原有字段
  graph?: unknown
}): Promise<TestPipeline> {
  const pool = getPool()
  const { rows } = await pool.query(
    `INSERT INTO test_pipelines (product_line_id, name, description, stages, server_roles, schedule, enabled, trigger_params, variables, artifact_inputs, graph)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [data.productLineId, data.name, data.description ?? '', JSON.stringify(data.stages),
     JSON.stringify(data.serverRoles), data.schedule ?? '', data.enabled ?? true,
     JSON.stringify(data.triggerParams ?? {}), JSON.stringify(data.variables ?? {}),
     JSON.stringify(data.artifactInputs ?? []),
     data.graph !== undefined ? JSON.stringify(data.graph) : null]
  )
  return mapRow(rows[0])
}
```

`updateTestPipeline` 同理，多一列 graph + `COALESCE($11, graph)`。

- [ ] **Step 4: 新增 setPipelineGraph 专用函数**

```ts
export async function setPipelineGraph(id: number, graph: unknown | null): Promise<TestPipeline | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    `UPDATE test_pipelines SET graph = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [id, graph === null ? null : JSON.stringify(graph)]
  )
  return rows[0] ? mapRow(rows[0]) : null
}
```

- [ ] **Step 5: 类型检查**

Run: `pnpm tsc --noEmit`
Expected: 无错误。

- [ ] **Step 6: Commit**

```bash
git add src/db/repositories/test-pipelines.ts
git commit -m "feat(db): test-pipelines repository 读写 graph 列 + setPipelineGraph"
```

---

### Task 7: 执行器优先读取 graph 列

**Files:**
- Modify: `src/pipeline/executor.ts`（或 graph-runner.ts 入口，具体看当前代码）

- [ ] **Step 1: 定位当前入口**

Run: `grep -n 'buildGraphFromStages\|pipeline.stages' src/pipeline/executor.ts src/pipeline/graph-runner.ts`

读取相关行 ±20 行，找到把 `pipeline.stages` 传给 `buildGraphFromStages` 的地方。

- [ ] **Step 2: 改为读 graph 列、回退到 stages**

把 `buildGraphFromStages({ stages: pipeline.stages, ... })` 的那处调用改为：

```ts
import { linearizeStages } from './graph-migration.js'
import { buildGraphFromPipeline } from './graph-builder.js'
import type { PipelineGraph, StageDefinition } from './types.js'

const pipelineGraph: PipelineGraph = pipeline.graph
  ? (pipeline.graph as PipelineGraph)
  : linearizeStages(pipeline.stages as StageDefinition[])

const builder = buildGraphFromPipeline({
  graph: pipelineGraph,
  stageContext,
  hooks,
  triggerParams,
})
```

- [ ] **Step 3: 跑所有 pipeline 相关测试**

Run: `npx vitest run src/__tests__/unit/graph-runner.test.ts src/__tests__/unit/graph-builder.test.ts src/__tests__/unit/pipeline-capability-stage.test.ts`
Expected: 全 PASS。

- [ ] **Step 4: Commit**

```bash
git add src/pipeline/executor.ts src/pipeline/graph-runner.ts
git commit -m "feat(pipeline): executor 优先读 graph 列，NULL 时 linearize stages"
```

---

### Task 8: Admin API `/test-pipelines/:id/graph`

**Files:**
- Modify: `src/admin/routes/test-pipelines.ts`

- [ ] **Step 1: 在 registerTestPipelineRoutes 内追加两条路由**

```ts
app.get<{ Params: { id: string } }>('/test-pipelines/:id/graph', async (req, reply) => {
  const id = Number(req.params.id)
  const pipeline = await getTestPipelineById(id)
  if (!pipeline) return reply.status(404).send({ error: 'not found' })
  const { linearizeStages } = await import('../../pipeline/graph-migration.js')
  const graph = pipeline.graph ?? linearizeStages(pipeline.stages as any)
  return reply.send(graph)
})

app.put<{ Params: { id: string }; Body: { graph: unknown } }>('/test-pipelines/:id/graph', async (req, reply) => {
  const id = Number(req.params.id)
  const existing = await getTestPipelineById(id)
  if (!existing) return reply.status(404).send({ error: 'not found' })

  const body = req.body
  if (!body || typeof body !== 'object' || !('graph' in body)) {
    return reply.status(400).send({ error: 'body.graph required' })
  }
  const { validatePipelineGraph } = await import('../../pipeline/graph-validation.js')
  const result = validatePipelineGraph(body.graph as any)
  if (!result.ok) return reply.status(400).send({ error: 'invalid graph', details: result.errors })

  const { setPipelineGraph } = await import('../../db/repositories/test-pipelines.js')
  const saved = await setPipelineGraph(id, body.graph)
  return reply.send(saved)
})
```

- [ ] **Step 2: 本地启动 + 手工打一个请求**

Run（后端保持 `pnpm dev` 运行）:

```bash
# 确保先有一条 pipeline（用数据库已有的任何一条，取其 id）
curl -s http://localhost:3000/admin/test-pipelines/1/graph | jq .
```

Expected: 返回 `{ nodes: [...], edges: [...] }`，若该 pipeline graph 为 NULL 则是 linearize 出来的结果。

- [ ] **Step 3: PUT 无效图返回 400**

```bash
curl -s -X PUT http://localhost:3000/admin/test-pipelines/1/graph \
  -H 'Content-Type: application/json' \
  -d '{"graph":{"nodes":[{"id":"a"}],"edges":[{"id":"e1","source":"a","target":"ghost"}]}}' | jq .
```

Expected: `{ "error": "invalid graph", "details": ["edge e1 target references missing node: ghost"] }`，HTTP 400。

- [ ] **Step 4: Commit**

```bash
git add src/admin/routes/test-pipelines.ts
git commit -m "feat(admin): GET/PUT /test-pipelines/:id/graph 接口 + 静态校验"
```

---

## Phase B — 前端画布

### Task 9: 安装画布依赖

**Files:**
- Modify: `web/package.json`

- [ ] **Step 1: 安装**

```bash
cd web && pnpm add @xyflow/react @dagrejs/dagre ulidx
cd ..
```

- [ ] **Step 2: TypeScript 编译通过**

Run: `cd web && pnpm build -- --mode development 2>&1 | head -40`
（或只 tsc：`cd web && npx tsc --noEmit`）
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add web/package.json web/pnpm-lock.yaml
git commit -m "chore(web): 引入 @xyflow/react + @dagrejs/dagre + ulidx"
```

---

### Task 10: 前端类型 + API 客户端

**Files:**
- Create: `web/src/pipeline-canvas/types.ts`
- Create: `web/src/pipeline-canvas/api.ts`

- [ ] **Step 1: types.ts**

```ts
import type { Node, Edge } from '@xyflow/react'

export type StageType = 'script' | 'approval' | 'capability' | 'wait_webhook'

export interface StageFields {
  name: string
  stageType: StageType
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
}

export type ConditionSpec =
  | { kind: 'onSuccess' }
  | { kind: 'onFailure' }
  | { kind: 'expression'; expression: string }

export type StageNode = Node<StageFields & { id: string }>

export interface ConditionEdgeData {
  condition?: ConditionSpec
}
export type StageEdge = Edge<ConditionEdgeData>

// 后端 wire format（去掉 React Flow 的 data 包装）
export interface PipelineGraphWire {
  nodes: Array<StageFields & { id: string; position: { x: number; y: number } }>
  edges: Array<{ id: string; source: string; target: string; condition?: ConditionSpec }>
}
```

- [ ] **Step 2: api.ts**

```ts
import client from '../api/client'
import type { PipelineGraphWire } from './types'

export const getPipelineGraph = (id: number) =>
  client.get<PipelineGraphWire>(`/test-pipelines/${id}/graph`).then(r => r.data)

export const putPipelineGraph = (id: number, graph: PipelineGraphWire) =>
  client.put(`/test-pipelines/${id}/graph`, { graph }).then(r => r.data)
```

- [ ] **Step 3: Commit**

```bash
git add web/src/pipeline-canvas/
git commit -m "feat(web/canvas): 类型与 API 客户端"
```

---

### Task 11: usePipelineGraph hook

**Files:**
- Create: `web/src/pipeline-canvas/hooks/usePipelineGraph.ts`

- [ ] **Step 1: 实现 hook**

```ts
import { useState, useCallback, useRef } from 'react'
import type { StageNode, StageEdge, PipelineGraphWire } from '../types'

interface State {
  nodes: StageNode[]
  edges: StageEdge[]
  dirty: boolean
}

const MAX_UNDO = 50

export function usePipelineGraph(initial: PipelineGraphWire) {
  const [state, setState] = useState<State>(() => ({
    nodes: wireToNodes(initial),
    edges: wireToEdges(initial),
    dirty: false,
  }))
  const undoStack = useRef<Array<{ nodes: StageNode[]; edges: StageEdge[] }>>([])

  const pushHistory = useCallback(() => {
    undoStack.current.push({ nodes: state.nodes, edges: state.edges })
    if (undoStack.current.length > MAX_UNDO) undoStack.current.shift()
  }, [state.nodes, state.edges])

  const setNodes = useCallback((next: StageNode[]) => {
    setState(s => ({ ...s, nodes: next, dirty: true }))
  }, [])

  const setEdges = useCallback((next: StageEdge[]) => {
    setState(s => ({ ...s, edges: next, dirty: true }))
  }, [])

  const updateNodeData = useCallback((id: string, data: Partial<StageNode['data']>) => {
    pushHistory()
    setState(s => ({
      ...s,
      nodes: s.nodes.map(n => n.id === id ? { ...n, data: { ...n.data, ...data } } : n),
      dirty: true,
    }))
  }, [pushHistory])

  const updateEdgeCondition = useCallback((id: string, condition: StageEdge['data']) => {
    pushHistory()
    setState(s => ({
      ...s,
      edges: s.edges.map(e => e.id === id ? { ...e, data: condition } : e),
      dirty: true,
    }))
  }, [pushHistory])

  const undo = useCallback(() => {
    const prev = undoStack.current.pop()
    if (!prev) return
    setState(s => ({ ...s, nodes: prev.nodes, edges: prev.edges, dirty: true }))
  }, [])

  const resetDirty = useCallback(() => setState(s => ({ ...s, dirty: false })), [])

  const toWire = useCallback((): PipelineGraphWire => ({
    nodes: state.nodes.map(n => ({ ...n.data, id: n.id, position: n.position })),
    edges: state.edges.map(e => ({
      id: e.id, source: e.source, target: e.target,
      condition: e.data?.condition,
    })),
  }), [state])

  return {
    nodes: state.nodes, edges: state.edges, dirty: state.dirty,
    setNodes, setEdges, updateNodeData, updateEdgeCondition,
    undo, resetDirty, toWire,
  }
}

function wireToNodes(w: PipelineGraphWire): StageNode[] {
  return w.nodes.map(n => ({
    id: n.id,
    type: n.stageType,
    position: n.position,
    data: { ...n, id: n.id },
  }))
}
function wireToEdges(w: PipelineGraphWire): StageEdge[] {
  return w.edges.map(e => ({
    id: e.id, source: e.source, target: e.target,
    type: 'conditional',
    data: e.condition ? { condition: e.condition } : undefined,
  }))
}
```

- [ ] **Step 2: tsc 通过**

Run: `cd web && npx tsc --noEmit`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add web/src/pipeline-canvas/hooks/
git commit -m "feat(web/canvas): usePipelineGraph 状态 hook（undo + dirty + toWire）"
```

---

### Task 12: useAutoLayout hook（dagre）

**Files:**
- Create: `web/src/pipeline-canvas/hooks/useAutoLayout.ts`

- [ ] **Step 1: 实现**

```ts
import dagre from '@dagrejs/dagre'
import { useCallback } from 'react'
import type { StageNode, StageEdge } from '../types'

const NODE_W = 220
const NODE_H = 80

export function useAutoLayout() {
  return useCallback((nodes: StageNode[], edges: StageEdge[]): StageNode[] => {
    const g = new dagre.graphlib.Graph()
    g.setGraph({ rankdir: 'TB', nodesep: 40, ranksep: 60 })
    g.setDefaultEdgeLabel(() => ({}))

    for (const n of nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H })
    for (const e of edges) g.setEdge(e.source, e.target)

    dagre.layout(g)

    return nodes.map(n => {
      const pos = g.node(n.id)
      return {
        ...n,
        position: { x: pos.x - NODE_W / 2, y: pos.y - NODE_H / 2 },
      }
    })
  }, [])
}
```

- [ ] **Step 2: tsc 通过**

Run: `cd web && npx tsc --noEmit`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add web/src/pipeline-canvas/hooks/useAutoLayout.ts
git commit -m "feat(web/canvas): useAutoLayout 用 dagre 自动排版"
```

---

### Task 13: 4 种 Stage Node 组件

**Files:**
- Create: `web/src/pipeline-canvas/canvas/nodes/ScriptNode.tsx`
- Create: `web/src/pipeline-canvas/canvas/nodes/ApprovalNode.tsx`
- Create: `web/src/pipeline-canvas/canvas/nodes/CapabilityNode.tsx`
- Create: `web/src/pipeline-canvas/canvas/nodes/WebhookNode.tsx`
- Create: `web/src/pipeline-canvas/canvas/nodes/nodeTypes.ts`
- Create: `web/src/pipeline-canvas/canvas/nodes/StageNodeCard.tsx`

- [ ] **Step 1: StageNodeCard 公共壳**

```tsx
// web/src/pipeline-canvas/canvas/nodes/StageNodeCard.tsx
import { Handle, Position } from '@xyflow/react'
import { Card, Tag } from 'antd'
import type { CSSProperties, ReactNode } from 'react'

interface Props {
  color: string          // 左色带颜色
  typeLabel: string      // "运行脚本" / "人员审批" 等
  title: string          // node.data.name
  footer?: ReactNode
}
export function StageNodeCard({ color, typeLabel, title, footer }: Props) {
  const barStyle: CSSProperties = {
    position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, background: color,
    borderTopLeftRadius: 6, borderBottomLeftRadius: 6,
  }
  return (
    <Card size="small" style={{ width: 220, position: 'relative' }} styles={{ body: { padding: '8px 12px' } }}>
      <div style={barStyle} />
      <Handle type="target" position={Position.Top} />
      <Tag color={color}>{typeLabel}</Tag>
      <div style={{ fontWeight: 500, marginTop: 4 }}>{title || <span style={{ color: '#aaa' }}>未命名</span>}</div>
      {footer && <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>{footer}</div>}
      <Handle type="source" position={Position.Bottom} />
    </Card>
  )
}
```

- [ ] **Step 2: 四个具体节点组件**

```tsx
// ScriptNode.tsx
import type { NodeProps } from '@xyflow/react'
import type { StageNode } from '../../types'
import { StageNodeCard } from './StageNodeCard'

export function ScriptNode({ data }: NodeProps<StageNode>) {
  const preview = (data.script ?? '').split('\n')[0].slice(0, 40)
  return <StageNodeCard color="#1677ff" typeLabel="运行脚本" title={data.name} footer={preview || '无脚本'} />
}
```

```tsx
// ApprovalNode.tsx
import type { NodeProps } from '@xyflow/react'
import type { StageNode } from '../../types'
import { StageNodeCard } from './StageNodeCard'

export function ApprovalNode({ data }: NodeProps<StageNode>) {
  const count = (data.approverIds ?? []).length
  return <StageNodeCard color="#faad14" typeLabel="人员审批" title={data.name}
    footer={`${count} 位审批人`} />
}
```

```tsx
// CapabilityNode.tsx
import type { NodeProps } from '@xyflow/react'
import type { StageNode } from '../../types'
import { StageNodeCard } from './StageNodeCard'

export function CapabilityNode({ data }: NodeProps<StageNode>) {
  return <StageNodeCard color="#722ed1" typeLabel="Agent Capability" title={data.name}
    footer={data.capabilityKey || '未选择'} />
}
```

```tsx
// WebhookNode.tsx
import type { NodeProps } from '@xyflow/react'
import type { StageNode } from '../../types'
import { StageNodeCard } from './StageNodeCard'

export function WebhookNode({ data }: NodeProps<StageNode>) {
  return <StageNodeCard color="#8c8c8c" typeLabel="等待 Webhook" title={data.name}
    footer={data.webhookTag ? `tag: ${data.webhookTag}` : '未设置 tag'} />
}
```

- [ ] **Step 3: nodeTypes.ts 汇总**

```ts
import { ScriptNode } from './ScriptNode'
import { ApprovalNode } from './ApprovalNode'
import { CapabilityNode } from './CapabilityNode'
import { WebhookNode } from './WebhookNode'

export const nodeTypes = {
  script: ScriptNode,
  approval: ApprovalNode,
  capability: CapabilityNode,
  wait_webhook: WebhookNode,
}
```

- [ ] **Step 4: tsc 通过**

Run: `cd web && npx tsc --noEmit`
Expected: 无错误。

- [ ] **Step 5: Commit**

```bash
git add web/src/pipeline-canvas/canvas/nodes/
git commit -m "feat(web/canvas): 4 种 stage 节点组件 + 公共 StageNodeCard 壳"
```

---

### Task 14: 条件边组件

**Files:**
- Create: `web/src/pipeline-canvas/canvas/edges/ConditionalEdge.tsx`
- Create: `web/src/pipeline-canvas/canvas/edges/edgeTypes.ts`

- [ ] **Step 1: ConditionalEdge.tsx**

```tsx
import { BaseEdge, EdgeLabelRenderer, getBezierPath } from '@xyflow/react'
import type { EdgeProps } from '@xyflow/react'
import type { StageEdge } from '../../types'

function labelOf(data: StageEdge['data']): string {
  if (!data?.condition) return ''
  const c = data.condition
  if (c.kind === 'onSuccess') return '成功时'
  if (c.kind === 'onFailure') return '失败时'
  return `expr: ${c.expression.slice(0, 20)}`
}

export function ConditionalEdge(props: EdgeProps<StageEdge>) {
  const [path, labelX, labelY] = getBezierPath(props)
  const label = labelOf(props.data)
  return (
    <>
      <BaseEdge id={props.id} path={path} markerEnd={props.markerEnd} />
      {label && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%,-50%) translate(${labelX}px, ${labelY}px)`,
              background: '#fff', padding: '2px 6px', border: '1px solid #d9d9d9',
              borderRadius: 4, fontSize: 11,
            }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}
```

- [ ] **Step 2: edgeTypes.ts**

```ts
import { ConditionalEdge } from './ConditionalEdge'
export const edgeTypes = { conditional: ConditionalEdge }
```

- [ ] **Step 3: tsc**

Run: `cd web && npx tsc --noEmit`
Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add web/src/pipeline-canvas/canvas/edges/
git commit -m "feat(web/canvas): ConditionalEdge 边组件（成功时/失败时/expression 标签）"
```

---

### Task 15: PipelineCanvas 画布壳

**Files:**
- Create: `web/src/pipeline-canvas/canvas/PipelineCanvas.tsx`

- [ ] **Step 1: 实现**

```tsx
import { ReactFlow, Background, Controls, applyNodeChanges, applyEdgeChanges, addEdge } from '@xyflow/react'
import type { NodeChange, EdgeChange, Connection, OnConnect } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { ulid } from 'ulidx'
import { useCallback } from 'react'
import { nodeTypes } from './nodes/nodeTypes'
import { edgeTypes } from './edges/edgeTypes'
import type { StageNode, StageEdge } from '../types'

interface Props {
  nodes: StageNode[]
  edges: StageEdge[]
  setNodes: (n: StageNode[]) => void
  setEdges: (e: StageEdge[]) => void
  onSelectNode: (id: string | null) => void
}
export function PipelineCanvas({ nodes, edges, setNodes, setEdges, onSelectNode }: Props) {
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes(applyNodeChanges(changes, nodes) as StageNode[])
  }, [nodes, setNodes])

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges(applyEdgeChanges(changes, edges) as StageEdge[])
  }, [edges, setEdges])

  const onConnect: OnConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target) return
    const newEdge: StageEdge = {
      id: ulid(), source: c.source, target: c.target,
      type: 'conditional',
    }
    setEdges(addEdge(newEdge, edges) as StageEdge[])
  }, [edges, setEdges])

  return (
    <div style={{ width: '100%', height: '100%' }}>
      <ReactFlow
        nodes={nodes} edges={edges}
        nodeTypes={nodeTypes} edgeTypes={edgeTypes}
        onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={(_, n) => onSelectNode(n.id)}
        onPaneClick={() => onSelectNode(null)}
        fitView
      >
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  )
}
```

- [ ] **Step 2: tsc**

Run: `cd web && npx tsc --noEmit`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add web/src/pipeline-canvas/canvas/PipelineCanvas.tsx
git commit -m "feat(web/canvas): PipelineCanvas 画布壳（React Flow 集成）"
```

---

### Task 16: NodeInspector Drawer

**Files:**
- Create: `web/src/pipeline-canvas/panels/NodeInspector.tsx`

- [ ] **Step 1: 实现（复用 TestPipelinesPage 中的 StageTypeFields 字段，但因 StageTypeFields 依赖 Form.List 的 name 路径，这里不直接复用组件，改为独立 Form）**

```tsx
import { Drawer, Form, Input, InputNumber, Select, Switch } from 'antd'
import { useEffect } from 'react'
import type { StageNode } from '../types'

interface Props {
  node: StageNode | null
  onClose: () => void
  onChange: (id: string, data: Partial<StageNode['data']>) => void
  availableRoles: string[]
  dingtalkUsers: { userId: string; name: string }[]
}

export function NodeInspector({ node, onClose, onChange, availableRoles, dingtalkUsers }: Props) {
  const [form] = Form.useForm()
  useEffect(() => {
    if (node) form.setFieldsValue(node.data)
  }, [node, form])

  if (!node) return null

  function commit() {
    const values = form.getFieldsValue()
    onChange(node!.id, values)
  }

  return (
    <Drawer title={`节点: ${node.data.name || '未命名'}`} open onClose={onClose} width={420}>
      <Form form={form} layout="vertical" onValuesChange={commit}>
        <Form.Item name="name" label="名称" rules={[{ required: true }]}>
          <Input />
        </Form.Item>
        <Form.Item name="stageType" label="类型">
          <Select options={[
            { value: 'script', label: '运行脚本' },
            { value: 'approval', label: '人员审批' },
            { value: 'capability', label: 'Agent Capability' },
            { value: 'wait_webhook', label: '等待 Webhook' },
          ]} />
        </Form.Item>
        <Form.Item name="targetRoles" label="目标角色">
          <Select mode="multiple" options={availableRoles.map(r => ({ value: r, label: r }))} />
        </Form.Item>
        <Form.Item name="timeoutSeconds" label="超时(秒)">
          <InputNumber min={10} />
        </Form.Item>
        <Form.Item name="retryCount" label="重试次数">
          <InputNumber min={0} max={5} />
        </Form.Item>
        <Form.Item name="onFailure" label="失败策略">
          <Select options={[{ value: 'stop', label: '停止' }, { value: 'continue', label: '继续' }]} />
        </Form.Item>
        <Form.Item name="parallel" label="并行" valuePropName="checked">
          <Switch />
        </Form.Item>

        <Form.Item shouldUpdate={(p, c) => p.stageType !== c.stageType} noStyle>
          {({ getFieldValue }) => {
            const t = getFieldValue('stageType')
            if (t === 'script') return (
              <Form.Item name="script" label="脚本">
                <Input.TextArea rows={8} style={{ fontFamily: 'monospace', fontSize: 12 }} />
              </Form.Item>
            )
            if (t === 'approval') return (
              <>
                <Form.Item name="approverIds" label="审批人">
                  <Select mode="multiple" options={dingtalkUsers.map(u => ({ value: u.userId, label: u.name }))} />
                </Form.Item>
                <Form.Item name="approvalDescription" label="审批描述">
                  <Input />
                </Form.Item>
              </>
            )
            if (t === 'capability') return (
              <Form.Item name="capabilityKey" label="Capability Key">
                <Input placeholder="pipeline_xxx / deploy / ..." />
              </Form.Item>
            )
            if (t === 'wait_webhook') return (
              <Form.Item name="webhookTag" label="Webhook Tag">
                <Input />
              </Form.Item>
            )
            return null
          }}
        </Form.Item>
      </Form>
    </Drawer>
  )
}
```

- [ ] **Step 2: tsc**

Run: `cd web && npx tsc --noEmit`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add web/src/pipeline-canvas/panels/NodeInspector.tsx
git commit -m "feat(web/canvas): NodeInspector Drawer（4 种 stage type 字段切换）"
```

---

### Task 17: VariablesPanel（展示 vars / artifactInputs / serverRoles）

**Files:**
- Create: `web/src/pipeline-canvas/panels/VariablesPanel.tsx`

- [ ] **Step 1: 实现（只读展示，不编辑——编辑仍回到列表页旧表单，避免 MVP 范围膨胀）**

```tsx
import { Collapse, Tag, Typography, message } from 'antd'
import type { TestPipeline } from '../../types'

interface Props {
  pipeline: TestPipeline | null
  variableCatalog: { key: string; description: string; category: string }[]
}

export function VariablesPanel({ pipeline, variableCatalog }: Props) {
  if (!pipeline) return null

  function copy(s: string) {
    navigator.clipboard.writeText(s).then(() => message.success(`已复制 ${s}`))
  }

  const items = [
    {
      key: 'vars',
      label: '自定义变量',
      children: (
        <div>
          {Object.entries(pipeline.variables ?? {}).map(([k, v]) => (
            <Tag key={k} color="blue" style={{ cursor: 'pointer', marginBottom: 4 }}
              onClick={() => copy(`{{vars.${k}}}`)} title={v}>
              {`{{vars.${k}}}`}
            </Tag>
          ))}
          <Typography.Text type="secondary" style={{ display: 'block', fontSize: 11, marginTop: 4 }}>
            * 变量值在列表页编辑
          </Typography.Text>
        </div>
      ),
    },
    {
      key: 'artifacts',
      label: '制品输入',
      children: (
        <div>
          {(pipeline.artifactInputs ?? []).map((a: any) => (
            <Tag key={a.outputVar} color="purple" style={{ cursor: 'pointer', marginBottom: 4 }}
              onClick={() => copy(`{{vars.${a.outputVar}}}`)}>
              {`{{vars.${a.outputVar}}}`}
            </Tag>
          ))}
        </div>
      ),
    },
    {
      key: 'serverRoles',
      label: '服务器角色',
      children: (
        <div>
          {Object.entries(pipeline.serverRoles ?? {}).map(([r, c]) => (
            <Tag key={r} color="green">{r} × {(c as any).count}</Tag>
          ))}
        </div>
      ),
    },
    {
      key: 'builtin',
      label: '内置变量',
      children: (
        <div>
          {variableCatalog.map(v => (
            <Tag key={v.key} color="default" style={{ cursor: 'pointer', marginBottom: 4 }}
              onClick={() => copy(`{{${v.key}}}`)} title={v.description}>
              {`{{${v.key}}}`}
            </Tag>
          ))}
        </div>
      ),
    },
  ]

  return <Collapse items={items} defaultActiveKey={['vars', 'artifacts']} size="small" />
}
```

- [ ] **Step 2: tsc**

Run: `cd web && npx tsc --noEmit`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add web/src/pipeline-canvas/panels/VariablesPanel.tsx
git commit -m "feat(web/canvas): VariablesPanel 右侧折叠变量/制品/角色只读展示"
```

---

### Task 18: CanvasToolbar 顶栏

**Files:**
- Create: `web/src/pipeline-canvas/toolbar/CanvasToolbar.tsx`

- [ ] **Step 1: 实现**

```tsx
import { Button, Space, Tooltip } from 'antd'
import { SaveOutlined, PlayCircleOutlined, DeploymentUnitOutlined, RollbackOutlined, UndoOutlined } from '@ant-design/icons'

interface Props {
  pipelineName: string
  dirty: boolean
  onSave: () => void
  onAutoLayout: () => void
  onTrigger: () => void
  onUndo: () => void
  onBackToList: () => void
}

export function CanvasToolbar(p: Props) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', padding: '8px 16px', borderBottom: '1px solid #f0f0f0', background: '#fff' }}>
      <div style={{ fontWeight: 600, marginRight: 16 }}>
        {p.pipelineName}
        {p.dirty && <span style={{ color: '#faad14', marginLeft: 8, fontSize: 12 }}>● 未保存</span>}
      </div>
      <Space style={{ marginLeft: 'auto' }}>
        <Tooltip title="撤销"><Button icon={<UndoOutlined />} onClick={p.onUndo} /></Tooltip>
        <Button icon={<DeploymentUnitOutlined />} onClick={p.onAutoLayout}>自动排版</Button>
        <Button icon={<PlayCircleOutlined />} onClick={p.onTrigger}>触发执行</Button>
        <Button type="primary" icon={<SaveOutlined />} onClick={p.onSave} disabled={!p.dirty}>保存</Button>
        <Button icon={<RollbackOutlined />} onClick={p.onBackToList}>返回列表</Button>
      </Space>
    </div>
  )
}
```

- [ ] **Step 2: tsc**

Run: `cd web && npx tsc --noEmit`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add web/src/pipeline-canvas/toolbar/CanvasToolbar.tsx
git commit -m "feat(web/canvas): CanvasToolbar 顶栏（保存/触发/排版/撤销/返回）"
```

---

### Task 19: PipelineCanvasPage 装配容器

**Files:**
- Create: `web/src/pipeline-canvas/PipelineCanvasPage.tsx`

- [ ] **Step 1: 实现**

```tsx
import { useEffect, useState, useMemo, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ReactFlowProvider } from '@xyflow/react'
import { Spin, message, Modal } from 'antd'
import { getTestPipeline } from '../api/test-pipelines'
import { getPipelineVariables } from '../api/pipeline-variables'
import { getDingTalkUsers } from '../api/dingtalk-users'
import { getTestServers } from '../api/test-servers'
import { getPipelineGraph, putPipelineGraph } from './api'
import { usePipelineGraph } from './hooks/usePipelineGraph'
import { useAutoLayout } from './hooks/useAutoLayout'
import { PipelineCanvas } from './canvas/PipelineCanvas'
import { NodeInspector } from './panels/NodeInspector'
import { VariablesPanel } from './panels/VariablesPanel'
import { CanvasToolbar } from './toolbar/CanvasToolbar'
import type { TestPipeline } from '../types'

export default function PipelineCanvasPage() {
  const { id } = useParams<{ id: string }>()
  const nav = useNavigate()
  const pipelineId = Number(id)

  const [pipeline, setPipeline] = useState<TestPipeline | null>(null)
  const [variableCatalog, setVariableCatalog] = useState<any[]>([])
  const [dingtalkUsers, setDingtalkUsers] = useState<{ userId: string; name: string }[]>([])
  const [availableRoles, setAvailableRoles] = useState<string[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [graphReady, setGraphReady] = useState(false)

  const graph = usePipelineGraph({ nodes: [], edges: [] })
  const autoLayout = useAutoLayout()

  useEffect(() => {
    let cancelled = false
    async function load() {
      const [p, cat, users, wire] = await Promise.all([
        getTestPipeline(pipelineId),
        getPipelineVariables(),
        getDingTalkUsers().then(r => r.users.map(u => ({ userId: u.userId, name: u.name }))),
        getPipelineGraph(pipelineId),
      ])
      if (cancelled) return
      setPipeline(p)
      setVariableCatalog(cat)
      setDingtalkUsers(users)
      const servers = await getTestServers(p.productLineId)
      setAvailableRoles([...new Set(servers.map(s => s.role).filter(Boolean))])
      graph.setNodes(wire.nodes.map(n => ({
        id: n.id, type: n.stageType, position: n.position, data: { ...n },
      })) as any)
      graph.setEdges(wire.edges.map(e => ({
        id: e.id, source: e.source, target: e.target, type: 'conditional',
        data: e.condition ? { condition: e.condition } : undefined,
      })) as any)
      graph.resetDirty()
      setGraphReady(true)
      setLoading(false)
    }
    load().catch(e => {
      message.error(e?.response?.data?.error ?? '加载失败')
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [pipelineId])

  const selectedNode = useMemo(
    () => graph.nodes.find(n => n.id === selectedId) ?? null,
    [graph.nodes, selectedId]
  )

  async function handleSave() {
    try {
      await putPipelineGraph(pipelineId, graph.toWire())
      graph.resetDirty()
      message.success('已保存')
    } catch (e: any) {
      const details = e?.response?.data?.details
      message.error(details ? `校验失败：${details.join('; ')}` : (e?.response?.data?.error ?? '保存失败'))
    }
  }

  const handleAutoLayout = useCallback(() => {
    graph.setNodes(autoLayout(graph.nodes, graph.edges))
  }, [graph, autoLayout])

  function handleBackToList() {
    if (graph.dirty) {
      Modal.confirm({
        title: '有未保存改动',
        content: '离开会丢失未保存内容，确定吗？',
        onOk: () => nav('/pipelines'),
      })
    } else {
      nav('/pipelines')
    }
  }

  function handleTrigger() {
    if (graph.dirty) {
      message.warning('请先保存再触发')
      return
    }
    nav(`/pipelines?trigger=${pipelineId}`)
  }

  if (loading || !graphReady) return <Spin style={{ margin: 48 }} />

  return (
    <ReactFlowProvider>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
        <CanvasToolbar
          pipelineName={pipeline?.name ?? ''}
          dirty={graph.dirty}
          onSave={handleSave}
          onAutoLayout={handleAutoLayout}
          onTrigger={handleTrigger}
          onUndo={graph.undo}
          onBackToList={handleBackToList}
        />
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          <div style={{ flex: 1 }}>
            <PipelineCanvas
              nodes={graph.nodes} edges={graph.edges}
              setNodes={graph.setNodes} setEdges={graph.setEdges}
              onSelectNode={setSelectedId}
            />
          </div>
          <div style={{ width: 280, borderLeft: '1px solid #f0f0f0', padding: 12, overflow: 'auto' }}>
            <VariablesPanel pipeline={pipeline} variableCatalog={variableCatalog} />
          </div>
        </div>
        <NodeInspector
          node={selectedNode}
          onClose={() => setSelectedId(null)}
          onChange={graph.updateNodeData}
          availableRoles={availableRoles}
          dingtalkUsers={dingtalkUsers}
        />
      </div>
    </ReactFlowProvider>
  )
}
```

- [ ] **Step 2: tsc**

Run: `cd web && npx tsc --noEmit`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add web/src/pipeline-canvas/PipelineCanvasPage.tsx
git commit -m "feat(web/canvas): PipelineCanvasPage 装配容器（加载/保存/自动排版/撤销）"
```

---

### Task 20: 路由挂载 + 列表页"画布编辑"入口

**Files:**
- Modify: `web/src/App.tsx`（或路由定义文件）
- Modify: `web/src/pages/TestPipelinesPage.tsx`

- [ ] **Step 1: 定位路由**

Run: `grep -n 'Routes\|Route' web/src/App.tsx | head -20`
读取文件对应行 ±10 行，确认现有路由定义风格。

- [ ] **Step 2: 添加 /pipelines/:id/canvas 路由**

在 App.tsx 路由列表追加（lazy import 以不影响首屏）：

```tsx
import { lazy, Suspense } from 'react'
const PipelineCanvasPage = lazy(() => import('./pipeline-canvas/PipelineCanvasPage'))

// ...在 <Routes> 内:
<Route path="/pipelines/:id/canvas" element={
  <Suspense fallback={null}><PipelineCanvasPage /></Suspense>
} />
```

- [ ] **Step 3: 列表页"操作"列追加"画布编辑"入口**

在 `TestPipelinesPage.tsx` 的 `columns` 数组中的操作列追加一个链接：

```tsx
<a onClick={() => nav(`/pipelines/${r.id}/canvas`)}>画布编辑</a>
```

需要在顶部 import `useNavigate` 并调用：`const nav = useNavigate()`。

保留原有"编辑"按钮不动（退路）。

- [ ] **Step 4: 前端 build 通过**

Run: `cd web && pnpm build`
Expected: 产物输出到 `web/dist/` 无错误。

- [ ] **Step 5: Commit**

```bash
git add web/src/App.tsx web/src/pages/TestPipelinesPage.tsx
git commit -m "feat(web/canvas): 挂载 /pipelines/:id/canvas 路由 + 列表页画布入口"
```

---

### Task 21: 空 pipeline 的"新增首节点"入口

**Files:**
- Modify: `web/src/pipeline-canvas/PipelineCanvasPage.tsx`

**背景：** 上面流程对有 stage 的 pipeline 能正常 load；但一个空图状态下用户无法开始——需要一个"添加节点"的入口。

- [ ] **Step 1: CanvasToolbar 追加"添加节点"菜单**

```tsx
// CanvasToolbar.tsx 新 prop：onAddNode: (type: StageType) => void
// 用 Dropdown 渲染一个"添加节点 ▼"按钮，菜单有 4 种 stage type
```

修改 Toolbar：

```tsx
import { Dropdown, type MenuProps } from 'antd'
import { PlusOutlined } from '@ant-design/icons'

// 在 Space 内最前面追加：
<Dropdown menu={{ items: [
  { key: 'script', label: '运行脚本' },
  { key: 'approval', label: '人员审批' },
  { key: 'capability', label: 'Agent Capability' },
  { key: 'wait_webhook', label: '等待 Webhook' },
] satisfies MenuProps['items'], onClick: (e) => p.onAddNode(e.key as any) }}>
  <Button icon={<PlusOutlined />}>添加节点</Button>
</Dropdown>
```

- [ ] **Step 2: PipelineCanvasPage 实现 handleAddNode**

```tsx
import { ulid } from 'ulidx'
import type { StageType } from './types'

const defaultStageFields = (type: StageType) => ({
  name: `新${type}节点`,
  stageType: type,
  targetRoles: [] as string[],
  parallel: false,
  timeoutSeconds: 300,
  retryCount: 0,
  onFailure: 'stop' as const,
  ...(type === 'script' ? { script: '' } : {}),
  ...(type === 'approval' ? { approverIds: [], approvalDescription: '' } : {}),
  ...(type === 'capability' ? { capabilityKey: '' } : {}),
  ...(type === 'wait_webhook' ? { webhookTag: '' } : {}),
})

function handleAddNode(type: StageType) {
  const id = ulid()
  const node = {
    id, type, position: { x: 200, y: 200 + graph.nodes.length * 140 },
    data: { id, ...defaultStageFields(type) },
  }
  graph.setNodes([...graph.nodes, node as any])
}
```

并把 `handleAddNode` 传给 Toolbar。

- [ ] **Step 3: build**

Run: `cd web && pnpm build`
Expected: 通过。

- [ ] **Step 4: Commit**

```bash
git add web/src/pipeline-canvas/
git commit -m "feat(web/canvas): CanvasToolbar '添加节点' 下拉 + 4 种类型默认字段"
```

---

### Task 22: Edge 条件编辑 Popover

**Files:**
- Create: `web/src/pipeline-canvas/panels/EdgeConditionPopover.tsx`
- Modify: `web/src/pipeline-canvas/PipelineCanvasPage.tsx`
- Modify: `web/src/pipeline-canvas/canvas/PipelineCanvas.tsx`

**背景：** spec §7.1 承诺"连线时弹出小面板选 onSuccess / onFailure / expression"。画布已能连线，但当前连线生成的 edge 无 condition；需要：①点击已有 edge 弹面板编辑 ②新建 edge 可为其设置 condition。

- [ ] **Step 1: 创建 EdgeConditionPopover**

```tsx
// web/src/pipeline-canvas/panels/EdgeConditionPopover.tsx
import { Modal, Radio, Input, Form } from 'antd'
import { useEffect } from 'react'
import type { ConditionSpec } from '../types'

interface Props {
  open: boolean
  initial?: ConditionSpec
  onClose: () => void
  onSubmit: (c: ConditionSpec | undefined) => void
}
export function EdgeConditionPopover({ open, initial, onClose, onSubmit }: Props) {
  const [form] = Form.useForm()
  useEffect(() => {
    if (open) form.setFieldsValue({ kind: initial?.kind ?? 'none', expression: (initial as any)?.expression ?? '' })
  }, [open, initial, form])

  function handleOk() {
    const { kind, expression } = form.getFieldsValue()
    if (kind === 'none') { onSubmit(undefined); onClose(); return }
    if (kind === 'expression') {
      if (!expression?.trim()) { form.setFields([{ name: 'expression', errors: ['必填'] }]); return }
      onSubmit({ kind: 'expression', expression: expression.trim() })
    } else {
      onSubmit({ kind })
    }
    onClose()
  }

  return (
    <Modal title="连线条件" open={open} onOk={handleOk} onCancel={onClose}>
      <Form form={form} layout="vertical">
        <Form.Item name="kind" label="触发条件">
          <Radio.Group>
            <Radio value="none">无条件（总是走）</Radio>
            <Radio value="onSuccess">上游成功时</Radio>
            <Radio value="onFailure">上游失败时</Radio>
            <Radio value="expression">自定义表达式</Radio>
          </Radio.Group>
        </Form.Item>
        <Form.Item shouldUpdate={(p, c) => p.kind !== c.kind} noStyle>
          {({ getFieldValue }) => getFieldValue('kind') === 'expression' ? (
            <Form.Item name="expression" label="表达式（首版仅支持两种模板）" extra="status === 'success'|'failed'|'skipped'  或  output.includes('...')">
              <Input placeholder="如: output.includes('RETRY')" />
            </Form.Item>
          ) : null}
        </Form.Item>
      </Form>
    </Modal>
  )
}
```

- [ ] **Step 2: PipelineCanvas 暴露 onEdgeClick**

在 `canvas/PipelineCanvas.tsx` props 中增加 `onEdgeClick: (id: string) => void`，并在 `<ReactFlow>` 上加：

```tsx
onEdgeClick={(_, e) => onEdgeClick(e.id)}
```

- [ ] **Step 3: PipelineCanvasPage 接入 popover**

在 `PipelineCanvasPage.tsx` 顶部增加 state：

```tsx
import { EdgeConditionPopover } from './panels/EdgeConditionPopover'
const [editingEdgeId, setEditingEdgeId] = useState<string | null>(null)
const editingEdge = graph.edges.find(e => e.id === editingEdgeId) ?? null
```

传给画布：`onEdgeClick={(id) => setEditingEdgeId(id)}`

在 JSX 末尾追加：

```tsx
<EdgeConditionPopover
  open={!!editingEdge}
  initial={editingEdge?.data?.condition}
  onClose={() => setEditingEdgeId(null)}
  onSubmit={(c) => {
    if (!editingEdgeId) return
    graph.updateEdgeCondition(editingEdgeId, c ? { condition: c } : undefined)
  }}
/>
```

- [ ] **Step 4: build + 手工验证**

Run: `cd web && pnpm build`
Expected: 通过。

打开 dev server，画布点击已有 edge → 弹面板 → 选"上游成功时" → 确定 → 观察边上出现"成功时"标签。

- [ ] **Step 5: Commit**

```bash
git add web/src/pipeline-canvas/panels/EdgeConditionPopover.tsx web/src/pipeline-canvas/canvas/PipelineCanvas.tsx web/src/pipeline-canvas/PipelineCanvasPage.tsx
git commit -m "feat(web/canvas): 点击 edge 弹面板编辑 condition（onSuccess/onFailure/expression）"
```

---

## Phase C — 验证与手册

### Task 23: 冒烟手册更新

**Files:**
- Modify: `docs/pipeline-smoke.md`（若无则 create）

- [ ] **Step 1: 追加"可视化画布"章节**

在文件末尾追加：

```markdown
## 可视化画布（2026-04-21）

### 前提
- `pnpm migrate` 已执行，`test_pipelines.graph` 列存在
- 后端 `pnpm dev` 运行，前端 `cd web && pnpm dev` 运行

### 用例 1：现有线性 pipeline 打开画布
1. 列表页点击任意一条现有 pipeline 的「画布编辑」
2. 预期：画布显示为线性链（由 `linearizeStages` 自动生成），节点数与旧 stages 一致
3. 点击某个节点，右侧 Drawer 出现字段，修改名称后立刻 dirty 为 ●
4. 点"保存" → Toast "已保存"，dirty 清除
5. 刷新页面，修改持久化

### 用例 2：条件分支 pipeline
1. 新建一条只有一个 script stage 的 pipeline（列表页旧表单）
2. 进入画布，"添加节点 → 运行脚本" 2 次，共 3 个节点 A / B / C
3. A 连 B（默认无条件边）；A 连 C
4. 点击 A→B 的边 → Popover 弹出 → 选"上游成功时" → 确定，边上出现"成功时"标签
5. 点击 A→C 的边 → 选"上游失败时"
6. "自动排版" → 节点位置整理
7. 保存；打开 PG `select graph from test_pipelines where id = ...` → 能看到 3 nodes + 2 edges + condition
8. 列表页「执行」这条 pipeline，预期两条路径都可走通

### 用例 3：校验失败
1. 画布上选 B 节点 → 删除 → 保存
2. 预期：Toast 错误，details 列出 "edge ... target references missing node"
3. 前端不应崩溃，dirty 仍保留
```

- [ ] **Step 2: Commit**

```bash
git add docs/pipeline-smoke.md
git commit -m "docs(pipeline): 冒烟手册新增画布章节（线性打开/条件分支/校验失败）"
```

---

### Task 24: 端到端手工冒烟 + 收尾

- [ ] **Step 1: 跑全量单测**

Run: `pnpm test`
Expected: 全 PASS，无新增失败。

- [ ] **Step 2: 启动全栈并按手册跑一遍**

```bash
pnpm migrate         # 若还没跑
pnpm dev &           # 后端
cd web && pnpm dev   # 前端
```

按 `docs/pipeline-smoke.md` 的"可视化画布"三个用例人工走一遍，记录问题。

- [ ] **Step 3: 前端生产构建**

Run: `cd web && pnpm build`
Expected: 输出到 `web/dist/`，无 error 无 warning（或只有已知 warning）。

- [ ] **Step 4: 写收尾 commit（若有小修）**

若手工冒烟发现 bug，修完后：

```bash
git add -A
git commit -m "fix(web/canvas): 冒烟发现的 <具体问题>"
```

- [ ] **Step 5: 打一个里程碑 tag**

```bash
git tag pipeline-canvas-mvp
```

（不 push 远端，等 PR review 后再推。）

---

## 非范围（明确不在本 MVP）

- 运行态实时高亮（V2）——需要 SSE/WebSocket，画布 read-only mode
- Interrupt/Resume 画布直点（V2）
- YAML 导入导出（V3）
- 节点模板库、子流程、多人协同
- 前端 Vitest 测试基建（等 V2 统一引入）

## 成功标准

- Phase A 所有单测 PASS，`pnpm test` 绿灯
- 用例 1：所有现有 pipeline 在画布中打开拓扑正确、字段无丢失
- 用例 2：能在画布里新建 3 节点 + 2 边 pipeline 并保存
- 用例 3：保存无效图返回 400 + details
- 前端生产构建通过
