# Pipeline Switch 节点 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 pipeline 引擎里新增一个独立的 switch 分支节点，让流水线能基于上游 LLM agent 的结构化产出做条件路由；同时下线 edge.condition.expression 的白名单 2 模板，统一切到 parseExpression 引擎。

**Architecture:** Switch 是 standalone NodeExecutor（与 fan_out 同列入 `ExecutorNodeStageType` union），params 里挂 `cases[]` + `default`；运行时 case 表达式按序求值，命中后写 `stepOutputs[switchId].output.matchedTarget`，graph-builder 出边特化 router 读这个字段做路由。配套 LLM 节点新增 `outputFormat: 'string' | 'json'`（stage 级默认 'json'），运行时 JSON.parse 后写入 stepOutputs 供 switch 表达式下钻。schema-v44 一次 migration 完成节点类型注册 + llm_agent outputFormat 显式补全 + edge expression 语法归一化。

**Frontend 配置模式：** **switch 节点完全通过画布配置，NodeInspector 不显示表格**（用户决策 2026-04-27：表单驱动节点配置模式后续会整体下线）。具体：用户从 switch 普通 source handle 拖出的每条 edge 自动派生为一个 case（按创建顺序）；switch 节点底部第二个 special handle（紫色 `default`）拖出的 edge 派生为 default。edge 右键弹出 popover 编辑 `when` 表达式，**写回 `switch.params.cases[i].when`**（不写到 `edge.condition`）。删除 edge 自动同步删除对应 case。

**Tech Stack:** TypeScript / Vitest / Fastify / @langchain/langgraph (graph-builder) / PostgreSQL (jsonb) / React 18 + @xyflow/react v12 + antd v5（无新依赖）

**Spec 来源：** [docs/superpowers/specs/2026-04-27-pipeline-switch-node-design.md](../../Documents/Code/chatops/docs/superpowers/specs/2026-04-27-pipeline-switch-node-design.md)（10 章节、481 行，含完整决策摘要、伪代码、SQL）

---

## Context

**Why this change:** 现有 pipeline 引擎缺独立的分支节点，路由能力依赖 edge.condition 上挂的白名单 2 模板（`status === 'X'` / `output.includes('Y')`），无法读 LLM 节点产出的结构化 JSON 字段。典型场景如"LLM 识别意图后产出 `{intent: 'rollback', score: 90}` 自动路由到回滚 / 部署 / 人工复核分支"在当前模型下无法表达。本次新增 switch 节点 + 升级 edge expression 引擎到 parseExpression（已支持 `==/!=/</>/>=/&&/||/!/contains` + 路径访问），一次性解决路由表达力问题。

**Intended outcome：**
1. 用户在画布拖一个 switch 节点，配 cases 表（when/target）+ default，运行时按表达式自动路由
2. LLM 节点产出（合法 JSON 对象）自动 parse 写入 stepOutputs，下游表达式可下钻 `steps.upstream.output.score > 80`
3. 旧白名单语法（`===` / `.includes(...)`) 通过 v44 migration 自动归一化，零回归
4. graph-validation 在保存阶段拦截非法配置（缺 default、target 指向不存在节点、表达式语法错等）

---

## File Structure（一次性概览）

**后端：**
- `src/pipeline/types.ts` — `ExecutorNodeStageType` union 加 `'switch'`；`StageDefinition` 加 `outputFormat?: 'string' | 'json'`
- `src/pipeline/node-types/switch.ts` — 新文件，registerNodeType 实现 switch executor
- `src/pipeline/node-types/index.ts` — 加 `import './switch.js'` barrel
- `src/pipeline/graph-builder.ts` — buildCapabilityNode 加 outputFormat JSON.parse；dispatcher 加 `case 'switch'`；边接线循环加 switch 路由特化分支；conditionMatches 升级为 evalExpression
- `src/pipeline/graph-validation.ts` — checkRequiredFields 加 switch 分支；新增 target 引用检测、case.when 预解析、edge.expression 预解析、outputFormat enum 校验
- `src/db/schema-v44.sql` — 新文件，三段 SQL（节点类型注册 + llm_agent outputFormat 补全 + edge expression 归一化）
- `src/db/migrate.ts` — `SCHEMA_FILES` 数组追加 `['v44', 'schema-v44.sql']`

**测试：**
- `src/__tests__/unit/switch-node.test.ts` — switch executor 单测
- `src/__tests__/unit/graph-validation-switch.test.ts` — switch 校验规则
- `src/__tests__/unit/llm-agent-output-format.test.ts` — outputFormat JSON.parse 兜底
- `src/__tests__/unit/condition-matches-parse-expr.test.ts` — conditionMatches 升级
- `src/__tests__/integration/switch-routing-e2e.test.ts` — 端到端路由（真 mock capability hook + 真 graph runner）
- `src/__tests__/unit/v44-migration.test.ts` — v44 migration jsonb 改写正确性 + 幂等性

**前端：**
- `web/src/pipeline-canvas/types.ts` — `StageType` union 加 `'switch'`；`StageFields` 加 `outputFormat`
- `web/src/pipeline-canvas/canvas/nodes/SwitchNode.tsx` — 新文件，菱形 + 紫底 + ✦ 视觉，**双 source handle**（普通 cases + 紫色 default）
- `web/src/pipeline-canvas/canvas/nodes/nodeTypes.ts` — 注册 `switch: SwitchNode`
- `web/src/pipeline-canvas/panels/NodeInspector.tsx` — **switch 节点只显示 name + 帮助文字**（"通过画布拖线配置 cases，default handle 在节点右下"）；llm_agent 加 outputFormat Radio
- `web/src/pipeline-canvas/panels/EdgeConditionPopover.tsx` — switch 出边特殊分支：编辑 `when` 写回 `switch.params.cases[i].when`（不写到 edge.condition）；其它边保持原有 expression 引擎升级 + hint 文案更新
- `web/src/pipeline-canvas/hooks/usePipelineGraph.ts` — 加边/删边/改条件时**反向 sync** 到 switch.params.cases / params.default
- `web/src/pipeline-canvas/canvas/PipelineCanvas.tsx` — `onConnect` 里识别 source handle id，区分普通 case edge 与 default edge；不再用 isValidConnection 拦截

---

## Critical Existing Code（plan 各 Task 会引用）

| 关键模块 | 路径 / 行号 | 用途 |
|---------|-----------|-----|
| `parseExpression(src)` AST 解析 | `src/pipeline/expressions.ts` | switch.when / edge.expression 预解析 + 求值 |
| `evalExpression(src \| Expr, ctx)` 求值 | 同上 | 已支持 `== != < <= > >= && \|\| ! contains`、路径访问；抛错由 caller 兜底 |
| `registerNodeType({ key, execute })` | `src/pipeline/node-types/registry.ts` | switch 注册标准入口 |
| `ExecutionContext` shape | `src/pipeline/node-types/types.ts:11-29` | `ctx.steps` / `ctx.vars` / `ctx.triggerParams` 字段名（spec §3.3 ctx 完全对齐） |
| `fan-out.ts` standalone 节点 | `src/pipeline/node-types/fan-out.ts` | switch.ts 的现成模板 |
| `buildCapabilityNode` | `graph-builder.ts:217-244` | outputFormat JSON.parse 落点 |
| `conditionMatches(cond, result)` | `graph-builder.ts:855-863` | 升级签名 + 改用 evalExpression |
| switch dispatcher | `graph-builder.ts:894-916` | 加 `case 'switch':` |
| 边接线循环 / `addConditionalEdges` | `graph-builder.ts:938-974` | switch 路由特化分支落点 |
| `checkRequiredFields(n)` | `graph-validation.ts:136-173` | 加 switch 分支 |
| `parseExpression` 预解析模板 | `graph-validation.ts:86-93`（retryWhen 模式） | switch.when / edge.expression 复用此模式 |
| `_migrations` 表 + `SCHEMA_FILES` | `src/db/migrate.ts:18-106` | v44 注册 |
| 现有 stale 兼容（`<ExclamationCircleTwoTone />`） | `web/src/pipeline-canvas/panels/NodeInspector.tsx:30-59` | switch target Select 复用 |
| `nodeTypes` map | `web/src/pipeline-canvas/canvas/nodes/nodeTypes.ts` | 注册 switch 视觉 |
| `StageNodeCard` 节点卡片底层 | `web/src/pipeline-canvas/canvas/nodes/StageNodeCard.tsx` | SwitchNode 复用结构（仅改 shape + color） |

---

## 实施次序

按 spec §9 实施次序拆 14 个 Task。**后端 Task 1-9 必须串行**（后置 Task 依赖前置类型/函数）；**前端 Task 10-13 与后端并行无关**（在 Task 1 完成后即可启动）；**Task 14 集成测试** 必须等 Task 1-9 全部完成。

---

## Task 1: types.ts — ExecutorNodeStageType + outputFormat 字段

**Files:**
- Modify: `src/pipeline/types.ts:18-26` (`ExecutorNodeStageType` union), `:27-63` (`StageDefinition` 接口)

**目的：** 给 union 加 `'switch'`、给 StageDefinition 加 `outputFormat`，使 TypeScript 编译能识别 switch stageType 与 llm_agent 的 outputFormat 字段。

- [ ] **Step 1: 扩展 ExecutorNodeStageType union**

修改 `src/pipeline/types.ts:18-26`，把
```ts
export type ExecutorNodeStageType =
  | 'sql_query' | 'http' | 'db_update' | 'dm' | 'file_read' | 'template_render' | 'fan_out'
```
改为
```ts
export type ExecutorNodeStageType =
  | 'sql_query' | 'http' | 'db_update' | 'dm' | 'file_read' | 'template_render' | 'fan_out' | 'switch'
```

- [ ] **Step 2: StageDefinition 加 outputFormat 字段**

在 `StageDefinition` 接口（`types.ts:27-63`）的合适位置插入：
```ts
/** 仅对 llm_agent 节点有意义。运行时默认 'json'（stage 级默认）；旧 graph 经 v44 migration 显式补 'string' 保现状 */
outputFormat?: 'string' | 'json'
```

- [ ] **Step 3: 验证类型编译**

Run: `cd /Users/yan/Documents/Code/chatops && pnpm exec tsc --noEmit`
Expected: PASS（无 TS error；如果旧代码 switch dispatcher 有 exhaustive 检查会先 error，此时跳到 Task 3 一起完成）

- [ ] **Step 4: Commit**

```bash
git add src/pipeline/types.ts
git commit -m "feat(pipeline-types): ExecutorNodeStageType 加 'switch' + StageDefinition.outputFormat"
```

---

## Task 2: switch NodeExecutor 实现

**Files:**
- Create: `src/pipeline/node-types/switch.ts`
- Modify: `src/pipeline/node-types/index.ts` (barrel import)
- Test: `src/__tests__/unit/switch-node.test.ts`

**目的：** 单文件实现 switch executor 逻辑（cases 顺序求值、命中即返回 matchedTarget、全 false 走 default）。完全独立单测覆盖。

- [ ] **Step 1: 写 switch-node.test.ts 单测（5 个 case）**

Create `src/__tests__/unit/switch-node.test.ts`：
```ts
import { describe, it, expect } from 'vitest'
import '../../pipeline/node-types/switch.js'
import { getNodeExecutor } from '../../pipeline/node-types/registry.js'

const executor = getNodeExecutor('switch')!
const baseCtx = {
  runId: 'r', pipelineId: 'p', nodeId: 'sw1',
  triggerParams: {}, vars: {},
  steps: { q: { status: 'success', output: { score: 90, intent: 'rollback' } } },
}

describe('switch node executor', () => {
  it('命中第一个 case → matchedCaseIndex=0', async () => {
    const r = await executor.execute({
      cases: [
        { when: "steps.q.output.intent == 'rollback'", target: 't1' },
        { when: "steps.q.output.score > 50", target: 't2' },
      ],
      default: 'tD',
    }, baseCtx)
    expect(r.status).toBe('success')
    expect(r.output).toEqual({ matchedCaseIndex: 0, matchedTarget: 't1', matchedWhen: "steps.q.output.intent == 'rollback'" })
  })

  it('first-match-wins：多 case 同时 true 取第一个', async () => {
    const r = await executor.execute({
      cases: [
        { when: 'steps.q.output.score > 80', target: 't1' },
        { when: 'steps.q.output.score > 50', target: 't2' },
      ],
      default: 'tD',
    }, baseCtx)
    expect((r.output as any).matchedCaseIndex).toBe(0)
    expect((r.output as any).matchedTarget).toBe('t1')
  })

  it('全 false → 走 default，matchedCaseIndex=null', async () => {
    const r = await executor.execute({
      cases: [{ when: 'steps.q.output.score > 999', target: 't1' }],
      default: 'tD',
    }, baseCtx)
    expect(r.status).toBe('success')
    expect(r.output).toEqual({ matchedCaseIndex: null, matchedTarget: 'tD', matchedWhen: null })
  })

  it('case.when 求值抛错 → status=failed，error 带 case 序号', async () => {
    const r = await executor.execute({
      cases: [{ when: '++++ invalid syntax', target: 't1' }],
      default: 'tD',
    }, baseCtx)
    expect(r.status).toBe('failed')
    expect(r.error).toMatch(/cases\[0\]\.when/)
  })

  it('cases 缺失 → status=failed（运行时兜底，graph-validation 已守门）', async () => {
    const r = await executor.execute({ default: 'tD' } as any, baseCtx)
    expect(r.status).toBe('failed')
  })
})
```

- [ ] **Step 2: Run 测试看 fail**

Run: `cd /Users/yan/Documents/Code/chatops && npx vitest run src/__tests__/unit/switch-node.test.ts`
Expected: FAIL — `getNodeExecutor('switch')` 返回 undefined（switch 未注册）

- [ ] **Step 3: 实现 switch.ts**

Create `src/pipeline/node-types/switch.ts`：
```ts
import { registerNodeType } from './registry.js'
import { evalExpression } from '../expressions.js'

interface SwitchParams {
  cases?: Array<{ when?: string; target?: string }>
  default?: string
}

registerNodeType({
  key: 'switch',
  async execute(rawParams, ctx) {
    const params = (rawParams ?? {}) as SwitchParams
    const cases = params.cases
    const defaultTarget = params.default

    if (!Array.isArray(cases) || cases.length === 0) {
      return { status: 'failed', output: {}, error: 'switch: cases 必须是非空数组' }
    }
    if (typeof defaultTarget !== 'string' || !defaultTarget.trim()) {
      return { status: 'failed', output: {}, error: 'switch: default 必填' }
    }

    const evalCtx = { steps: ctx.steps, vars: ctx.vars, triggerParams: ctx.triggerParams }

    for (let i = 0; i < cases.length; i++) {
      const c = cases[i]
      if (typeof c?.when !== 'string' || typeof c?.target !== 'string') {
        return { status: 'failed', output: {}, error: `switch: cases[${i}] when/target 必须是字符串` }
      }
      try {
        if (evalExpression(c.when, evalCtx)) {
          return {
            status: 'success',
            output: { matchedCaseIndex: i, matchedTarget: c.target, matchedWhen: c.when },
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return { status: 'failed', output: {}, error: `switch cases[${i}].when 求值错误: ${msg}` }
      }
    }
    return {
      status: 'success',
      output: { matchedCaseIndex: null, matchedTarget: defaultTarget, matchedWhen: null },
    }
  },
})
```

- [ ] **Step 4: 加 barrel import**

修改 `src/pipeline/node-types/index.ts`，在已有 `import './fan-out.js'` 之后追加：
```ts
import './switch.js'
```

- [ ] **Step 5: Run 测试看 pass**

Run: `npx vitest run src/__tests__/unit/switch-node.test.ts`
Expected: PASS（5 个 it 全绿）

- [ ] **Step 6: Commit**

```bash
git add src/pipeline/node-types/switch.ts src/pipeline/node-types/index.ts src/__tests__/unit/switch-node.test.ts
git commit -m "feat(pipeline): 新增 switch NodeExecutor + 单测"
```

---

## Task 3: graph-builder dispatcher 加 'switch' case

**Files:**
- Modify: `src/pipeline/graph-builder.ts:894-916` (buildExecutorNode dispatcher)

**目的：** 让 switch 节点走 buildExecutorNode 通用 dispatcher，复用现有的 stage result / stepOutputs 写入逻辑。**注意：** 出边路由特化在 Task 4 单独处理，此处只让 switch 节点的 execute 调到。

- [ ] **Step 1: 找到 dispatcher 位置确认现状**

Read `src/pipeline/graph-builder.ts:894-916`。预期看到形如：
```ts
case 'sql_query':
case 'http':
case 'db_update':
case 'dm':
case 'file_read':
case 'template_render':
case 'fan_out':
  return buildExecutorNode(node, ...)
```

- [ ] **Step 2: 加 case 'switch'**

在 dispatcher 中将
```ts
case 'fan_out':
  return buildExecutorNode(node, ...)
```
改为
```ts
case 'fan_out':
case 'switch':
  return buildExecutorNode(node, ...)
```

- [ ] **Step 3: tsc 通过**

Run: `pnpm exec tsc --noEmit`
Expected: PASS（switch 已纳入 ExecutorNodeStageType union，dispatcher exhaustive 不再 error）

- [ ] **Step 4: Commit**

```bash
git add src/pipeline/graph-builder.ts
git commit -m "feat(graph-builder): switch 纳入 buildExecutorNode dispatcher"
```

---

## Task 4: graph-builder 出边路由特化（switch 专用 router）

**Files:**
- Modify: `src/pipeline/graph-builder.ts:938-974` (边接线循环)

**目的：** switch 出边不走 condition 匹配，而是读 `state.stepOutputs[switchId].output.matchedTarget` 直接路由。

- [ ] **Step 1: 写集成单测占位（先骨架，Task 14 补完）**

暂时跳到 Step 2 — switch 路由集成测试集中在 Task 14。本 Task 只做实现，TS 编译 + 现有测试不退化即可。

- [ ] **Step 2: 边接线循环加 switch 分支**

在 `graph-builder.ts:938-974` 边接线循环（`for (const node of ...)` 块）开头，在通用 router 闭包之前插入：

```ts
if (node.stageType === 'switch') {
  builder.addConditionalEdges(name, (state: PipelineStateAnnotation.State) => {
    const result = state.stageResults.find(r => r.name === lookupName)
    if (result && shouldStopAfter(node, result)) return skipName
    if (!result || result.status === 'failed') return skipName  // 求值错走 sink
    const stepOutput = state.stepOutputs[node.id]
    const matchedTarget = (stepOutput?.output as { matchedTarget?: unknown } | undefined)?.matchedTarget
    if (typeof matchedTarget !== 'string') return END
    const targetName = idToName.get(matchedTarget)
    if (!targetName || !routeMap[targetName]) return END
    return targetName
  }, routeMap)
  builder.addEdge(skipName, END)
  continue
}
```

**注意：**
1. `routeMap` 在循环上文已构造（见 graph-builder.ts:956 左近），它聚合了**所有** out edges 的 target name 与对应路由索引。switch 节点不再读 `outs`，而是直接根据 stepOutputs 决定。
2. switch failed 时（cases 求值抛错）走 skipName 与普通节点一致。
3. `shouldStopAfter` 闭包内已可用，无需额外引入。

- [ ] **Step 3: tsc + 跑 graph-builder 现有单测**

Run: `pnpm exec tsc --noEmit && npx vitest run src/__tests__/unit/graph-builder.test.ts`
Expected: PASS（switch 路由分支只对 stageType='switch' 生效，不影响现有节点）

- [ ] **Step 4: Commit**

```bash
git add src/pipeline/graph-builder.ts
git commit -m "feat(graph-builder): switch 节点出边路由特化（读 matchedTarget 直接路由）"
```

---

## Task 5: conditionMatches 升级（白名单 2 模板下线，统一走 evalExpression）

**Files:**
- Modify: `src/pipeline/graph-builder.ts:855-863` (`conditionMatches` 函数), `:962-971` (调用点)
- Test: `src/__tests__/unit/condition-matches-parse-expr.test.ts`

**目的：** 边路由 condition expression 不再用白名单 2 模板，统一走 parseExpression。新签名带 `state` + `triggerParams` 以构造完整 ctx。

- [ ] **Step 1: 写 conditionMatches 升级单测**

Create `src/__tests__/unit/condition-matches-parse-expr.test.ts`：
```ts
import { describe, it, expect } from 'vitest'
// 注：conditionMatches 当前是 graph-builder 内部 function，需要 export 或通过 buildGraphFromStages 间接测
// 此处假设 Task 5 Step 3 把 conditionMatches export 出来用于测试
import { conditionMatches } from '../../pipeline/graph-builder.js'

const baseState = {
  stageResults: [],
  stepOutputs: { upstream: { status: 'success' as const, output: { score: 90 } } },
  runtimeVars: {},
  currentStageIndex: 0,
} as any

describe('conditionMatches (parseExpression 引擎)', () => {
  it('onSuccess kind', () => {
    const r = { status: 'success', name: 'x', output: '' } as any
    expect(conditionMatches({ kind: 'onSuccess' } as any, r, baseState, {})).toBe(true)
    expect(conditionMatches({ kind: 'onSuccess' } as any, { ...r, status: 'failed' }, baseState, {})).toBe(false)
  })

  it("expression: status == 'success' 等价 onSuccess", () => {
    const r = { status: 'success', name: 'x', output: '' } as any
    expect(conditionMatches({ kind: 'expression', expression: "status == 'success'" } as any, r, baseState, {})).toBe(true)
  })

  it("expression: output contains 'foo' 等价旧 .includes", () => {
    const r = { status: 'success', name: 'x', output: 'hello foo bar' } as any
    expect(conditionMatches({ kind: 'expression', expression: "output contains 'foo'" } as any, r, baseState, {})).toBe(true)
  })

  it('expression 能访问 stepOutputs', () => {
    const r = { status: 'success', name: 'x', output: '' } as any
    expect(conditionMatches({ kind: 'expression', expression: 'steps.upstream.output.score > 80' } as any, r, baseState, {})).toBe(true)
  })

  it('解析失败 / 求值失败 统一返回 false（不抛）', () => {
    const r = { status: 'success', name: 'x', output: '' } as any
    expect(conditionMatches({ kind: 'expression', expression: '+++' } as any, r, baseState, {})).toBe(false)
    expect(conditionMatches({ kind: 'expression', expression: 'steps.nonexistent.deep.path > 0' } as any, r, baseState, {})).toBe(false)
  })
})
```

- [ ] **Step 2: Run 看 fail**

Run: `npx vitest run src/__tests__/unit/condition-matches-parse-expr.test.ts`
Expected: FAIL（conditionMatches 未 export 或仍是白名单 2 模板）

- [ ] **Step 3: 重写 conditionMatches**

修改 `src/pipeline/graph-builder.ts:855-863`：
```ts
import { evalExpression } from './expressions.js'  // 已 import 则跳过

export function conditionMatches(
  cond: ConditionSpec | undefined,
  result: StageResult,
  state: PipelineStateAnnotation.State,
  triggerParams: Record<string, unknown> | undefined,
): boolean {
  if (!cond) return true
  if (cond.kind === 'onSuccess') return result.status === 'success'
  if (cond.kind === 'onFailure') return result.status === 'failed'
  if (cond.kind === 'expression') {
    const ctx = {
      status: result.status,
      output: result.output,
      steps: state.stepOutputs,
      vars: state.runtimeVars,
      triggerParams: triggerParams ?? {},
    }
    try {
      return evalExpression(cond.expression, ctx)
    } catch {
      return false
    }
  }
  return false
}
```

- [ ] **Step 4: 调用点扩参**

修改 `graph-builder.ts:962-971` 通用 router 闭包：
```ts
for (const e of outs) {
  if (conditionMatches(e.condition, result, state, ctx.triggerParams)) {
    return idToName.get(e.target)!
  }
}
```
其中 `ctx.triggerParams` 来自 buildGraphFromStages 闭包参数（如不存在需从函数签名添加，与 buildCapabilityNode 同款）。

- [ ] **Step 5: Run 全部测试**

Run: `npx vitest run`
Expected: PASS（含本任务新测试 + 现有 graph-builder 测试不退化）

- [ ] **Step 6: Commit**

```bash
git add src/pipeline/graph-builder.ts src/__tests__/unit/condition-matches-parse-expr.test.ts
git commit -m "refactor(graph-builder): conditionMatches 升级为 parseExpression 引擎"
```

---

## Task 6: buildCapabilityNode — outputFormat='json' JSON.parse 落地

**Files:**
- Modify: `src/pipeline/graph-builder.ts:217-244` (buildCapabilityNode `hooks.runCapability` 后逻辑)
- Test: `src/__tests__/unit/llm-agent-output-format.test.ts`

**目的：** llm_agent 节点 outputFormat 为 'json' 时，`hooks.runCapability` 返回后尝试 JSON.parse；非 object 或 parse 失败 → stage failed；成功 → 写 stepOutputs 供下游 switch 表达式访问。outputFormat='string' 行为完全不变。

- [ ] **Step 1: 写 outputFormat 单测**

Create `src/__tests__/unit/llm-agent-output-format.test.ts`：
```ts
import { describe, it, expect, vi } from 'vitest'
import { buildGraphFromStages } from '../../pipeline/graph-builder.js'
// 测试 fixture：参考 src/__tests__/unit/graph-builder.test.ts makeStage / okHooks 模式

describe('buildCapabilityNode outputFormat', () => {
  it("默认 outputFormat='json'：合法 JSON object → 写 stepOutputs", async () => {
    const hook = vi.fn().mockResolvedValue({ status: 'success', output: '{"intent":"rollback","score":90}' })
    const graph = buildGraphFromStages([
      { id: 'q1', name: 'q', stageType: 'llm_agent', capabilityKey: 'k' },
    ], { runCapability: hook, /* 其它必填 hooks */ } as any)
    const result = await graph.compile().invoke({ /* 初始 state */ } as any)
    expect(result.stepOutputs?.q1?.output).toEqual({ intent: 'rollback', score: 90 })
  })

  it("outputFormat='json' + 非 object（数组）→ stage failed", async () => {
    const hook = vi.fn().mockResolvedValue({ status: 'success', output: '[1,2,3]' })
    // ... graph build + invoke
    // expect: stageResults 末项 status='failed', error 包含 'JSON 对象'
  })

  it("outputFormat='json' + parse 失败 → stage failed", async () => {
    const hook = vi.fn().mockResolvedValue({ status: 'success', output: 'not json' })
    // expect: error 包含 'parse 失败'
  })

  it("outputFormat='string'：保持现状，不写 stepOutputs", async () => {
    const hook = vi.fn().mockResolvedValue({ status: 'success', output: 'plain text' })
    // graph 节点带 outputFormat='string'
    // expect: stageResults.output === 'plain text', stepOutputs.q1 === undefined
  })
})
```

> **执行注：** 测试 fixture 复用 `src/__tests__/unit/graph-builder.test.ts` 的 `makeStage()` / `okHooks()` 工厂；具体 helper 引用方式参照该文件。

- [ ] **Step 2: Run 看 fail**

Run: `npx vitest run src/__tests__/unit/llm-agent-output-format.test.ts`
Expected: FAIL（buildCapabilityNode 未做 JSON.parse）

- [ ] **Step 3: 修改 buildCapabilityNode**

在 `graph-builder.ts:217-244` `hooks.runCapability` 调用返回后、`return { ... }` 之前插入：
```ts
const outputFormat = stage.outputFormat ?? 'json'
let stepOutput: { status: 'success'; output: Record<string, unknown> } | null = null

if (outputFormat === 'json' && exec.status === 'success') {
  try {
    const parsed = JSON.parse(exec.output)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      exec = { status: 'failed', output: exec.output, error: 'outputFormat=json: 输出必须是 JSON 对象' }
    } else {
      stepOutput = { status: 'success', output: parsed as Record<string, unknown> }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    exec = { status: 'failed', output: exec.output, error: `outputFormat=json: parse 失败: ${msg}` }
  }
}
```

修改原 return：
```ts
return {
  currentStageIndex: index,
  stageResults: finishedResult(stage, startedAt, startedMs, exec),
  ...(stepOutput ? { stepOutputs: { [(stage as PipelineNode).id ?? stage.name]: stepOutput } } : {}),
}
```

- [ ] **Step 4: Run 单测看 pass**

Run: `npx vitest run src/__tests__/unit/llm-agent-output-format.test.ts`
Expected: PASS

- [ ] **Step 5: Run 全部 pipeline 测试不退化**

Run: `npx vitest run src/__tests__/unit/graph-builder.test.ts src/__tests__/unit/graph-migration.test.ts`
Expected: PASS（**注意**：未带 outputFormat 字段的旧 fixture 默认走 'json' 分支，可能 break；如 break，需要 fixture 显式补 `outputFormat: 'string'` 或检查 hook mock 是否返回 JSON 对象。如出现退化是 v44 migration 在生产环境保持兼容的一面镜像 —— 旧 graph 在 migrate 后会显式带 'string'，此处单测 fixture 需手动跟进。）

- [ ] **Step 6: Commit**

```bash
git add src/pipeline/graph-builder.ts src/__tests__/unit/llm-agent-output-format.test.ts
git commit -m "feat(graph-builder): llm_agent outputFormat='json' 自动 parse 写 stepOutputs"
```

---

## Task 7: graph-validation §5 全部规则

**Files:**
- Modify: `src/pipeline/graph-validation.ts:34` (edge.expression 预解析), `:136-173` (checkRequiredFields)
- Test: `src/__tests__/unit/graph-validation-switch.test.ts`

**目的：** 保存 pipeline 时拦截 switch 节点的 7 类错误（cases 缺失 / default 缺失 / target 不存在 / target 自环 / when 语法错 / outputFormat 非 enum / edge.expression 语法错）。

- [ ] **Step 1: 写校验单测（7 case）**

Create `src/__tests__/unit/graph-validation-switch.test.ts`：
```ts
import { describe, it, expect } from 'vitest'
import { validateGraph } from '../../pipeline/graph-validation.js'

function buildGraph(nodes: any[], edges: any[] = []) {
  return { nodes, edges }
}

describe('graph-validation switch + outputFormat + expression', () => {
  it('cases 非数组 → 报错', () => {
    const errors = validateGraph(buildGraph([
      { id: 's', stageType: 'switch', params: { cases: 'foo', default: 'x' } },
      { id: 'x', stageType: 'sql_query' },
    ]))
    expect(errors.some(e => e.includes('cases'))).toBe(true)
  })

  it('cases 空数组 → 报错', () => {
    const errors = validateGraph(buildGraph([
      { id: 's', stageType: 'switch', params: { cases: [], default: 'x' } },
      { id: 'x', stageType: 'sql_query' },
    ]))
    expect(errors.some(e => e.includes('cases'))).toBe(true)
  })

  it('default 缺失 → 报错', () => {
    const errors = validateGraph(buildGraph([
      { id: 's', stageType: 'switch', params: { cases: [{ when: 'true', target: 'x' }] } },
      { id: 'x', stageType: 'sql_query' },
    ]))
    expect(errors.some(e => e.includes('default'))).toBe(true)
  })

  it('target 指向不存在节点 → 报错', () => {
    const errors = validateGraph(buildGraph([
      { id: 's', stageType: 'switch', params: { cases: [{ when: 'true', target: 'nonexistent' }], default: 'x' } },
      { id: 'x', stageType: 'sql_query' },
    ]))
    expect(errors.some(e => e.includes('nonexistent'))).toBe(true)
  })

  it('target 自环（target === switchId）→ 报错', () => {
    const errors = validateGraph(buildGraph([
      { id: 's', stageType: 'switch', params: { cases: [{ when: 'true', target: 's' }], default: 'x' } },
      { id: 'x', stageType: 'sql_query' },
    ]))
    expect(errors.some(e => e.includes('自己'))).toBe(true)
  })

  it('cases[i].when 语法错 → 报错', () => {
    const errors = validateGraph(buildGraph([
      { id: 's', stageType: 'switch', params: { cases: [{ when: '+++', target: 'x' }], default: 'x' } },
      { id: 'x', stageType: 'sql_query' },
    ]))
    expect(errors.some(e => e.includes('cases[0].when'))).toBe(true)
  })

  it('outputFormat 非 enum → 报错', () => {
    const errors = validateGraph(buildGraph([
      { id: 'q', stageType: 'llm_agent', capabilityKey: 'k', outputFormat: 'xml' as any },
    ]))
    expect(errors.some(e => e.includes('outputFormat'))).toBe(true)
  })

  it('edge.condition.expression 语法错 → 报错', () => {
    const errors = validateGraph(buildGraph(
      [{ id: 'a', stageType: 'sql_query' }, { id: 'b', stageType: 'sql_query' }],
      [{ source: 'a', target: 'b', condition: { kind: 'expression', expression: '+++' } }],
    ))
    expect(errors.some(e => e.includes('expression'))).toBe(true)
  })
})
```

- [ ] **Step 2: Run 看 fail**

Run: `npx vitest run src/__tests__/unit/graph-validation-switch.test.ts`
Expected: FAIL（校验规则尚未加）

- [ ] **Step 3: checkRequiredFields 加 switch 分支**

在 `graph-validation.ts:136-173` `checkRequiredFields(n)` 函数 switch case 链最后追加：
```ts
case 'switch': {
  const params = (n as unknown as { params?: { cases?: unknown; default?: unknown } }).params ?? {}
  if (!Array.isArray(params.cases) || params.cases.length === 0) {
    errors.push(`node "${n.id}" (stageType=switch): cases is required (non-empty array)`)
  }
  if (typeof params.default !== 'string' || !params.default.trim()) {
    errors.push(`node "${n.id}" (stageType=switch): default is required`)
  }
  if (Array.isArray(params.cases)) {
    params.cases.forEach((c: any, i: number) => {
      if (typeof c?.when !== 'string' || !c.when.trim()) {
        errors.push(`switch "${n.id}" cases[${i}].when 必填`)
      }
      if (typeof c?.target !== 'string' || !c.target.trim()) {
        errors.push(`switch "${n.id}" cases[${i}].target 必填`)
      }
    })
  }
  break
}
```

- [ ] **Step 4: 加 switch target 引用合法性 + 自环检测**

在 `validateGraph` 主函数（节点列表遍历后、edges 检测前）加独立循环：
```ts
const nodeIds = new Set(graph.nodes.map(n => n.id))
for (const n of graph.nodes) {
  if (n.stageType !== 'switch') continue
  const params = (n as any).params ?? {}
  const cases = Array.isArray(params.cases) ? params.cases : []
  cases.forEach((c: any, i: number) => {
    if (typeof c?.target === 'string' && c.target) {
      if (c.target === n.id) errors.push(`switch "${n.id}" cases[${i}].target 不能指向自己`)
      else if (!nodeIds.has(c.target)) errors.push(`switch "${n.id}" cases[${i}].target references unknown node: ${c.target}`)
    }
  })
  const dt = params.default
  if (typeof dt === 'string' && dt) {
    if (dt === n.id) errors.push(`switch "${n.id}" default 不能指向自己`)
    else if (!nodeIds.has(dt)) errors.push(`switch "${n.id}" default references unknown node: ${dt}`)
  }
}
```

- [ ] **Step 5: 加 case.when + edge.expression 预解析**

在 §5.3 / §5.4 落点处仿 `graph-validation.ts:86-93` 的 retryWhen 模式：

case.when 预解析（写在节点遍历内）：
```ts
if (n.stageType === 'switch') {
  const cases = (n as any).params?.cases
  if (Array.isArray(cases)) {
    cases.forEach((c: any, i: number) => {
      if (typeof c?.when === 'string' && c.when.trim()) {
        try { parseExpression(c.when) }
        catch (e) { errors.push(`switch "${n.id}" cases[${i}].when 语法错误: ${msg(e)}`) }
      }
    })
  }
}
```

edge.expression 预解析（修改 `graph-validation.ts:34` 周围）：
```ts
if (e.condition?.kind === 'expression') {
  if (!e.condition.expression?.trim()) {
    errors.push(`edge "${e.source}->${e.target}" expression 必填`)
  } else {
    try { parseExpression(e.condition.expression) }
    catch (err) { errors.push(`edge "${e.source}->${e.target}" expression 语法错误: ${msg(err)}`) }
  }
}
```

- [ ] **Step 6: outputFormat enum 校验**

在 `checkRequiredFields(n)` 或独立循环加：
```ts
const of = (n as any).outputFormat
if (of !== undefined && of !== 'string' && of !== 'json') {
  errors.push(`node "${n.id}" outputFormat 必须是 'string' 或 'json'，得到 ${JSON.stringify(of)}`)
}
```

- [ ] **Step 7: Run 单测看 pass**

Run: `npx vitest run src/__tests__/unit/graph-validation-switch.test.ts`
Expected: PASS（8 个 it 全绿）

- [ ] **Step 8: Run 全部 graph-validation 测试不退化**

Run: `npx vitest run src/__tests__/unit/graph-validation*`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/pipeline/graph-validation.ts src/__tests__/unit/graph-validation-switch.test.ts
git commit -m "feat(graph-validation): switch 节点字段/引用/表达式校验 + edge.expression 预解析 + outputFormat enum"
```

---

## Task 8: schema-v44 三段 SQL migration

**Files:**
- Create: `src/db/schema-v44.sql`
- Modify: `src/db/migrate.ts:18-61` (`SCHEMA_FILES` 数组)
- Test: `src/__tests__/unit/v44-migration.test.ts`

**目的：** 一次 migration 完成三件事：注册 switch 节点类型、给现存 llm_agent 节点显式补 `outputFormat='string'`、把 edge.condition.expression 老语法（`===` / `.includes()`）规范化为 `==` / `contains`。**幂等**：第二次执行 v44 是 no-op。

- [ ] **Step 1: 写 v44 migration 单测**

Create `src/__tests__/unit/v44-migration.test.ts`：
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Pool } from 'pg'
import { runMigration } from '../../db/migrate.js'  // 假设有 runMigration helper；如无则直接执行 SQL 文件

describe('v44 migration', () => {
  let pool: Pool
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL })
    // 跑到 v43，准备 fixture
    // ...
  })
  afterAll(async () => { await pool.end() })

  it('节点类型注册：pipeline_node_types 表加入 switch 行', async () => {
    await runMigration(pool, 'v44')
    const r = await pool.query("SELECT key FROM pipeline_node_types WHERE key='switch'")
    expect(r.rowCount).toBe(1)
  })

  it("llm_agent 节点显式补 outputFormat='string'", async () => {
    // 插入 fixture pipeline，含 llm_agent 节点（无 outputFormat）
    await pool.query(`INSERT INTO test_pipelines (name, graph) VALUES ('fix1', $1::jsonb)`,
      [JSON.stringify({ nodes: [{ id: 'q', stageType: 'llm_agent', capabilityKey: 'k' }], edges: [] })])
    await runMigration(pool, 'v44')
    const r = await pool.query("SELECT graph FROM test_pipelines WHERE name='fix1'")
    expect(r.rows[0].graph.nodes[0].outputFormat).toBe('string')
  })

  it("edge.condition.expression 归一化：=== → ==、.includes() → contains", async () => {
    await pool.query(`INSERT INTO test_pipelines (name, graph) VALUES ('fix2', $1::jsonb)`,
      [JSON.stringify({
        nodes: [{ id: 'a', stageType: 'sql_query' }, { id: 'b', stageType: 'sql_query' }],
        edges: [
          { source: 'a', target: 'b', condition: { kind: 'expression', expression: "status === 'success'" } },
          { source: 'a', target: 'b', condition: { kind: 'expression', expression: "output.includes('FOO')" } },
        ],
      })])
    await runMigration(pool, 'v44')
    const r = await pool.query("SELECT graph FROM test_pipelines WHERE name='fix2'")
    expect(r.rows[0].graph.edges[0].condition.expression).toBe("status == 'success'")
    expect(r.rows[0].graph.edges[1].condition.expression).toBe("output contains 'FOO'")
  })

  it('幂等：跑两次 v44 第二次 no-op', async () => {
    await runMigration(pool, 'v44')  // 第二次
    // 断言数据未变（与第一次执行后一致）
    const r = await pool.query("SELECT graph FROM test_pipelines WHERE name='fix2'")
    expect(r.rows[0].graph.edges[0].condition.expression).toBe("status == 'success'")
  })
})
```

> **注：** ChatOps 现有 db 测试是否存在 `runMigration(pool, version)` helper 不确定；如无，本测试需用 `pool.query(fs.readFileSync('src/db/schema-v44.sql', 'utf8'))` 直执行。Step 4 落地时确认。

- [ ] **Step 2: Run 看 fail**

Run: `npx vitest run src/__tests__/unit/v44-migration.test.ts`
Expected: FAIL（schema-v44.sql 文件不存在）

- [ ] **Step 3: 创建 schema-v44.sql**

Create `src/db/schema-v44.sql`：
```sql
-- v44: switch node type + llm_agent outputFormat backfill + edge expression syntax normalization

-- 7.1 注册 switch 节点类型
INSERT INTO pipeline_node_types (key, display_name, description)
VALUES ('switch', 'Switch 分支', '按 cases 表达式路由到不同下游节点')
ON CONFLICT (key) DO NOTHING;

-- 7.2 给现存 llm_agent 节点显式补 outputFormat='string'（graph.nodes[]）
UPDATE test_pipelines tp
   SET graph = (
     SELECT jsonb_set(tp.graph, '{nodes}', new_nodes)
     FROM (
       SELECT jsonb_agg(
         CASE WHEN n->>'stageType' = 'llm_agent' AND NOT (n ? 'outputFormat')
              THEN jsonb_set(n, '{outputFormat}', '"string"'::jsonb)
              ELSE n
         END
       ) AS new_nodes
       FROM jsonb_array_elements(tp.graph->'nodes') n
     ) sub
   )
 WHERE tp.graph IS NOT NULL
   AND jsonb_typeof(tp.graph->'nodes') = 'array'
   AND EXISTS (
     SELECT 1 FROM jsonb_array_elements(tp.graph->'nodes') n
     WHERE n->>'stageType' = 'llm_agent' AND NOT (n ? 'outputFormat')
   );

-- 7.2 (cont) 同样扫旧 linear stages 字段
UPDATE test_pipelines tp
   SET stages = (
     SELECT jsonb_agg(
       CASE WHEN s->>'stageType' = 'llm_agent' AND NOT (s ? 'outputFormat')
            THEN jsonb_set(s, '{outputFormat}', '"string"'::jsonb)
            ELSE s
       END
     )
     FROM jsonb_array_elements(tp.stages) s
   )
 WHERE tp.stages IS NOT NULL
   AND jsonb_typeof(tp.stages) = 'array'
   AND EXISTS (
     SELECT 1 FROM jsonb_array_elements(tp.stages) s
     WHERE s->>'stageType' = 'llm_agent' AND NOT (s ? 'outputFormat')
   );

-- 7.3 edge.condition.expression 语法归一化（=== → ==、.includes(X) → contains X）
UPDATE test_pipelines tp
   SET graph = (
     SELECT jsonb_set(tp.graph, '{edges}', new_edges)
     FROM (
       SELECT jsonb_agg(
         CASE WHEN e->'condition'->>'kind' = 'expression'
              THEN jsonb_set(
                     e,
                     '{condition,expression}',
                     to_jsonb(
                       regexp_replace(
                         regexp_replace(
                           e->'condition'->>'expression',
                           '\.includes\(([^)]+)\)', ' contains \1', 'g'
                         ),
                         '===', '==', 'g'
                       )
                     )
                   )
              ELSE e
         END
       ) AS new_edges
       FROM jsonb_array_elements(tp.graph->'edges') e
     ) sub
   )
 WHERE tp.graph IS NOT NULL
   AND jsonb_typeof(tp.graph->'edges') = 'array'
   AND EXISTS (
     SELECT 1 FROM jsonb_array_elements(tp.graph->'edges') e
     WHERE e->'condition'->>'kind' = 'expression'
       AND (e->'condition'->>'expression' LIKE '%===%'
            OR e->'condition'->>'expression' LIKE '%.includes(%')
   );
```

- [ ] **Step 4: 在 migrate.ts SCHEMA_FILES 追加**

修改 `src/db/migrate.ts:18-61` 数组末尾：
```ts
['v44', 'schema-v44.sql'],
```

- [ ] **Step 5: 本地 db 跑 migrate**

Run: `pnpm migrate`
Expected: log 显示 v44 已应用；`SELECT key FROM pipeline_node_types WHERE key='switch'` 返回 1 行。

- [ ] **Step 6: Run migration 单测看 pass**

Run: `npx vitest run src/__tests__/unit/v44-migration.test.ts`
Expected: PASS（4 个 it 全绿）

- [ ] **Step 7: Commit**

```bash
git add src/db/schema-v44.sql src/db/migrate.ts src/__tests__/unit/v44-migration.test.ts
git commit -m "feat(db): schema-v44 注册 switch 节点类型 + 回填 llm_agent outputFormat + 归一化 edge expression 语法"
```

---

## Task 9: 前端 types.ts 扩展

**Files:**
- Modify: `web/src/pipeline-canvas/types.ts`

**目的：** TypeScript 编译能识别 `'switch'` stageType 与 `outputFormat` 字段。

- [ ] **Step 1: 加 'switch' 到 StageType union**

修改 `web/src/pipeline-canvas/types.ts`：找到 `StageType` union，在末尾追加 `| 'switch'`。

- [ ] **Step 2: StageFields 加 outputFormat**

在 StageFields 接口加：
```ts
outputFormat?: 'string' | 'json'
```

> `params?: Record<string, unknown>` 字段已有，cases / default 走 params 不需要为类型显式增字段（但若想要 IDE 友好可加 `params?: { cases?: Array<{ when: string; target: string }>; default?: string; [k: string]: unknown }`）。

- [ ] **Step 3: tsc**

Run: `cd /Users/yan/Documents/Code/chatops/web && pnpm exec tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add web/src/pipeline-canvas/types.ts
git commit -m "feat(canvas-types): StageType 加 'switch' + StageFields.outputFormat"
```

---

## Task 10: SwitchNode 视觉组件（双 source handle）+ nodeTypes 注册

**Files:**
- Create: `web/src/pipeline-canvas/canvas/nodes/SwitchNode.tsx`
- Modify: `web/src/pipeline-canvas/canvas/nodes/nodeTypes.ts`

**目的：** 画布上 switch 节点显示菱形 + 紫底 + ✦ 图标 + cases 数量；**两个 source handle**：底部居中 = cases handle（普通），底部右侧 = default handle（紫色高亮，标 `default`）。

- [ ] **Step 1: 创建 SwitchNode 组件**

Create `web/src/pipeline-canvas/canvas/nodes/SwitchNode.tsx`：
```tsx
import { Handle, Position, NodeProps } from '@xyflow/react'
import { Tag } from 'antd'
import type { StageNode } from '../../types'

export function SwitchNode({ data, selected }: NodeProps<StageNode>) {
  const cases = (data.params as any)?.cases ?? []
  const defaultTarget = (data.params as any)?.default

  return (
    <div style={{
      width: 160, padding: 12,
      background: '#f9f0ff',
      border: `2px solid ${selected ? '#722ed1' : '#b37feb'}`,
      clipPath: 'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)',  // 菱形
      textAlign: 'center',
    }}>
      <Handle type="target" position={Position.Top} />
      <div style={{ fontSize: 18, color: '#722ed1' }}>✦</div>
      <div style={{ fontWeight: 600, fontSize: 13 }}>{data.name}</div>
      <Tag color="purple">{cases.length} cases</Tag>
      {defaultTarget ? <Tag>default ✓</Tag> : <Tag color="warning">无 default</Tag>}

      {/* cases handle：底部居中 */}
      <Handle id="cases" type="source" position={Position.Bottom}
        style={{ left: '50%', background: '#b37feb' }} />
      {/* default handle：底部右侧（紫色高亮，可见 label） */}
      <Handle id="default" type="source" position={Position.Bottom}
        style={{ left: '85%', background: '#722ed1', width: 12, height: 12 }} />
    </div>
  )
}
```

> **注：** 菱形用 `clip-path: polygon(...)` 实现，避免 transform 与 Handle 定位冲突。两个 handle 通过 `id="cases" / id="default"` 区分，`onConnect` 通过 `connection.sourceHandle` 识别。

- [ ] **Step 2: 注册到 nodeTypes map**

修改 `web/src/pipeline-canvas/canvas/nodes/nodeTypes.ts`：
```ts
import { SwitchNode } from './SwitchNode'

export const nodeTypes = {
  ...,
  switch: SwitchNode,
}
```

- [ ] **Step 3: dev 验证**

Run: `cd web && pnpm dev`，浏览器拖一个 switch 节点。Expected: 菱形紫底 + ✦ + 双 source handle 可见（底部 default handle 略偏右、深紫色，悬停 tooltip 显示 `default`）。

- [ ] **Step 4: Commit**

```bash
git add web/src/pipeline-canvas/canvas/nodes/SwitchNode.tsx web/src/pipeline-canvas/canvas/nodes/nodeTypes.ts
git commit -m "feat(canvas): SwitchNode 视觉组件（菱形+紫底+✦）+ 双 source handle（cases / default）"
```

---

## Task 11: NodeInspector — llm_agent outputFormat Radio（switch 节点不在此处配置）

**Files:**
- Modify: `web/src/pipeline-canvas/panels/NodeInspector.tsx`

**目的：** 切换到 llm_agent 节点显示 outputFormat Radio。**switch 节点的 cases / default 完全通过画布配置**，NodeInspector 仅显示 name + 一段帮助提示，不显示表格、不允许在面板编辑 params（与用户决策一致：表单驱动配置模式后续整体下线）。

- [ ] **Step 1: switch 分支落点（仅帮助文字）**

修改 `web/src/pipeline-canvas/panels/NodeInspector.tsx`，在 stageType case 链中加：
```tsx
if (t === 'switch') {
  return (
    <Alert
      type="info"
      message="Switch 节点配置说明"
      description={
        <div>
          <p><strong>添加 case：</strong>从节点底部居中的 source handle 拖一条线到目标节点。</p>
          <p><strong>设置 default：</strong>从节点底部右侧的紫色 handle 拖一条线到目标节点。</p>
          <p><strong>编辑表达式：</strong>右键边线 → 编辑 when。</p>
          <p><strong>调整顺序：</strong>右键边线 → 上移 / 下移。</p>
        </div>
      }
    />
  )
}
```

- [ ] **Step 2: llm_agent 分支加 outputFormat Radio**

在 `t === 'llm_agent'` 分支，已有 capabilityKey Form.Item 之后加：
```tsx
<Form.Item name="outputFormat" label="输出格式" initialValue="json"
  extra="JSON 模式下 capability 输出必须是 JSON 对象，否则该节点失败">
  <Radio.Group>
    <Radio value="json">JSON</Radio>
    <Radio value="string">字符串</Radio>
  </Radio.Group>
</Form.Item>
```

- [ ] **Step 3: dev 验证**

Run: `cd web && pnpm dev`
- 选 switch 节点 → NodeInspector 仅显示 name + 帮助 Alert
- 选 llm_agent 节点 → 见 outputFormat Radio

- [ ] **Step 4: Commit**

```bash
git add web/src/pipeline-canvas/panels/NodeInspector.tsx
git commit -m "feat(canvas-inspector): llm_agent outputFormat Radio + switch 节点帮助提示（switch 走画布配置）"
```

---

## Task 12: cases ⇐ edges 反向派生（画布操作 → 写回 switch.params）+ default handle

**Files:**
- Modify: `web/src/pipeline-canvas/hooks/usePipelineGraph.ts`
- Modify: `web/src/pipeline-canvas/canvas/PipelineCanvas.tsx`

**目的：** edges 是画布上 cases 的呈现，但 **switch.params.cases / params.default 仍是数据模型源头**（运行时不变）。前端通过 hooks 在 edge 增删时同步派生 cases / default 写回 params。

- [ ] **Step 1: usePipelineGraph 加 syncSwitchParams 工具**

修改 `web/src/pipeline-canvas/hooks/usePipelineGraph.ts`，加一个内部 helper：
```ts
const syncSwitchParams = useCallback((switchId: string) => {
  setNodes(prevNodes => {
    const switchEdges = currentEdges().filter(e => e.source === switchId)
    const cases: Array<{ when: string; target: string }> = []
    let defaultTarget: string | undefined

    for (const e of switchEdges) {
      if (e.sourceHandle === 'default') {
        defaultTarget = e.target  // 多次拖 default 取最后一条（前端 onConnect 应已先删旧 default edge）
      } else {
        // 复用 edge.data.label 里之前编辑过的 when（若没有则空串）
        const existing = ((findNode(prevNodes, switchId)?.data.params as any)?.cases ?? [])
          .find((c: any) => c.target === e.target)
        cases.push({ when: existing?.when ?? '', target: e.target })
      }
    }

    return prevNodes.map(n => n.id === switchId
      ? { ...n, data: { ...n.data, params: { ...(n.data.params as any), cases, default: defaultTarget } } }
      : n)
  })
}, [setNodes, currentEdges])
```

- [ ] **Step 2: onConnect 逻辑：default handle 互斥**

修改 `usePipelineGraph` 中的 `onConnect`（或 PipelineCanvas 里的 onConnect 回调）：
```ts
const onConnect = useCallback((c: Connection) => {
  setEdges(prev => {
    let next = prev
    // default handle 互斥：拖新 default 边 → 先删旧 default 边
    if (c.sourceHandle === 'default') {
      next = next.filter(e => !(e.source === c.source && e.sourceHandle === 'default'))
    }
    next = addEdge({
      ...c,
      id: `${c.source}-${c.sourceHandle ?? 'out'}-${c.target}-${Date.now()}`,
      data: { isDefault: c.sourceHandle === 'default' },
    }, next)
    return next
  })
  // 增 edge 后立即同步 cases
  if (isSwitch(c.source)) syncSwitchParams(c.source)
}, [setEdges, syncSwitchParams])
```

- [ ] **Step 3: 删 edge 时同步**

修改 `onEdgesDelete` / `setEdges` 包装：
```ts
const onEdgesDelete = useCallback((deleted: Edge[]) => {
  const switchSources = new Set(deleted.filter(e => isSwitch(e.source)).map(e => e.source))
  switchSources.forEach(syncSwitchParams)
}, [syncSwitchParams])
```

- [ ] **Step 4: case 顺序管理（右键菜单 上移/下移）**

在 EdgeConditionPopover（Task 13 改造）增加 2 个按钮：「↑ 上移」「↓ 下移」，操作时 reorder switch.params.cases 数组并同步重排 edges 数组。最简实现：
```ts
const moveCase = (switchId: string, fromIdx: number, toIdx: number) => {
  // 更新 switch.params.cases 数组顺序
  // 更新 edges 数组中 source=switchId 的 edges 顺序（保持视觉顺序对齐）
}
```

- [ ] **Step 5: 移除 isValidConnection 拦截**

如 Task 11 旧版有写 `isValidConnection` 在 PipelineCanvas，移除该 prop（switch 出边现在允许手拖创建）。

- [ ] **Step 6: SwitchNode 标签：edge 上加 case#N / default**

在 `web/src/pipeline-canvas/canvas/edges/` 找 default edge type（如有），或给所有 edges 加 EdgeLabelRenderer 渲染：
- switch 出边 default：标签 `default`，颜色 `#722ed1`
- switch 出边 cases：标签 `case#1`、`case#2`...，按 switch.params.cases 数组里位置渲染

最简实现：在 edge 渲染时读 `edge.data.isDefault` 判断 default；通过 `edges.findIndex(e => e.id === id)` 反推 case index。

- [ ] **Step 7: dev 验证**
- 拖 switch → llm_agent 节点的下游 → 自动出现 `case#1` 标签的边；switch 节点 cases 数量 +1
- 拖 switch default handle 到下游 → 出现紫色 `default` 标签的边；switch 节点显示 `default ✓`
- 删除一条 case edge → cases 数量 -1
- 再拖一次 default → 旧 default 边被替换

- [ ] **Step 8: Commit**

```bash
git add web/src/pipeline-canvas/hooks/usePipelineGraph.ts web/src/pipeline-canvas/canvas/PipelineCanvas.tsx web/src/pipeline-canvas/canvas/edges/
git commit -m "feat(canvas): switch cases ⇐ edges 反向派生 + default handle 互斥 + edge 标签 case#N/default"
```

---

## Task 13: EdgeConditionPopover — switch 出边写回 params.cases，普通边走 expression 升级

**Files:**
- Modify: `web/src/pipeline-canvas/panels/EdgeConditionPopover.tsx`

**目的：** 同一个 popover 处理两种 edge：
1. **switch 出边**：编辑 `when` 表达式，写回 `switch.params.cases[i].when`（不写到 edge.condition）；提供「上移 / 下移」case 顺序按钮；不允许编辑 condition kind
2. **普通 edge**：保持现有 condition 编辑（kind: onSuccess / onFailure / expression），expression 模式更新 hint 文案为新引擎能力

- [ ] **Step 1: popover 入口分支**

修改 `EdgeConditionPopover.tsx` 顶部，按 source 节点 stageType 分发：
```tsx
const sourceNode = nodes.find(n => n.id === edge.source)
if (sourceNode?.data.stageType === 'switch') {
  return <SwitchEdgeEditor edge={edge} switchNode={sourceNode} edges={edges} setNodes={setNodes} />
}
return <NormalEdgeEditor edge={edge} />  // 现有逻辑
```

- [ ] **Step 2: SwitchEdgeEditor 组件**

新增组件（写在同文件末尾或 `SwitchEdgeEditor.tsx`）：
```tsx
function SwitchEdgeEditor({ edge, switchNode, edges, setNodes }: Props) {
  const isDefault = edge.data?.isDefault === true
  const cases = (switchNode.data.params as any)?.cases ?? []
  const caseIdx = isDefault ? -1 : cases.findIndex((c: any) => c.target === edge.target)
  const initialWhen = caseIdx >= 0 ? cases[caseIdx].when : ''

  if (isDefault) {
    return <Alert message="Default 边不需要表达式（未命中任何 case 时跳转）" type="info" />
  }

  return (
    <Form initialValues={{ when: initialWhen }} onFinish={(values) => {
      // 写回 switch.params.cases[caseIdx].when
      setNodes(prev => prev.map(n => n.id === switchNode.id
        ? { ...n, data: { ...n.data, params: { ...(n.data.params as any),
            cases: cases.map((c: any, i: number) => i === caseIdx ? { ...c, when: values.when } : c)
        }}}
        : n))
    }}>
      <Form.Item label={`Case #${caseIdx + 1} 表达式`} name="when"
        extra="parseExpression 引擎，支持 ==/!=/</>/>=/&&/||/!/contains，路径访问 steps.x.output.y">
        <Input placeholder="steps.upstream.output.score > 80" />
      </Form.Item>
      <Space>
        <Button onClick={() => moveCase(caseIdx, caseIdx - 1)} disabled={caseIdx === 0}>↑ 上移</Button>
        <Button onClick={() => moveCase(caseIdx, caseIdx + 1)} disabled={caseIdx === cases.length - 1}>↓ 下移</Button>
        <Button type="primary" htmlType="submit">保存</Button>
      </Space>
    </Form>
  )
}
```

- [ ] **Step 3: NormalEdgeEditor — 更新 expression hint 文案**

修改 `NormalEdgeEditor`（即原 popover 内容）的 expression Form.Item：
```tsx
<Form.Item name="expression" label="表达式"
  extra="parseExpression 引擎，支持 ==/!=/</>/>=/&&/||/!/contains，路径访问 steps.x.output.y">
  <Input placeholder="steps.upstream.output.score > 80" />
</Form.Item>
```

- [ ] **Step 4: dev 验证**
- 右键 switch → A 节点的 case edge → 弹出 SwitchEdgeEditor，输入 `steps.q.output.score > 80` → 保存 → 检查 switch.params.cases 数组对应 case.when 已更新
- 右键 switch → default 节点边 → 显示 Alert（无表达式编辑）
- 右键普通节点边（如 sql_query → http）→ 弹出原 condition 编辑器，expression 模式 hint 已更新
- 上移 / 下移按钮 → cases 数组顺序变化、画布上 case 标签更新

- [ ] **Step 5: Commit**

```bash
git add web/src/pipeline-canvas/panels/EdgeConditionPopover.tsx
git commit -m "feat(canvas-popover): switch 出边专用编辑器（写回 params.cases）+ 普通边 expression hint 更新"
```

---

## Task 14: 端到端集成测试（switch routing e2e）

**Files:**
- Create: `src/__tests__/integration/switch-routing-e2e.test.ts`

**目的：** 用真 mock capability hook + 真 graph runner 跑完整路径，验证 LLM JSON 产出 → switch 路由 → 下游分支命中正确。

- [ ] **Step 1: 写 3 组场景**

Create `src/__tests__/integration/switch-routing-e2e.test.ts`：
```ts
import { describe, it, expect, vi } from 'vitest'
import { buildGraphFromStages } from '../../pipeline/graph-builder.js'
import '../../pipeline/node-types/switch.js'

const baseGraph = {
  nodes: [
    { id: 'q', name: 'classify', stageType: 'llm_agent', capabilityKey: 'classify', outputFormat: 'json' },
    { id: 'sw', name: 'route', stageType: 'switch', params: {
      cases: [
        { when: "steps.q.output.intent == 'rollback'", target: 'rb' },
        { when: "steps.q.output.intent == 'deploy'", target: 'dp' },
      ],
      default: 'manual',
    }},
    { id: 'rb', name: 'rollback', stageType: 'sql_query' },
    { id: 'dp', name: 'deploy', stageType: 'sql_query' },
    { id: 'manual', name: 'manual', stageType: 'sql_query' },
  ],
  edges: [
    { source: 'q', target: 'sw' },
    { source: 'sw', target: 'rb' },
    { source: 'sw', target: 'dp' },
    { source: 'sw', target: 'manual' },
  ],
}

describe('switch routing e2e', () => {
  it("LLM 产出 {intent:'rollback'} → 只走 rollback", async () => {
    const runCapability = vi.fn().mockResolvedValue({ status: 'success', output: '{"intent":"rollback","score":90}' })
    const runSql = vi.fn().mockResolvedValue({ status: 'success', output: '' })
    const graph = buildGraphFromStages(baseGraph as any, { runCapability, runSql /* + others */ } as any)
    const r = await graph.compile().invoke({} as any)
    expect(r.stageResults?.find((s: any) => s.name === 'rollback')).toBeDefined()
    expect(r.stageResults?.find((s: any) => s.name === 'deploy')).toBeUndefined()
    expect(r.stageResults?.find((s: any) => s.name === 'manual')).toBeUndefined()
  })

  it("LLM 产出 {intent:'unknown'} → 走 default(manual)", async () => {
    const runCapability = vi.fn().mockResolvedValue({ status: 'success', output: '{"intent":"unknown"}' })
    // ... 类似
    // expect: manual 执行，rollback / deploy 未执行
  })

  it('LLM 产出非 JSON 字符串 → q 节点 failed，switch 不被执行', async () => {
    const runCapability = vi.fn().mockResolvedValue({ status: 'success', output: 'not json' })
    // ... expect: q stage failed, sw 不在 stageResults 里
  })
})
```

> **执行注：** `runCapability`/`runSql` 等 hooks 接口与 `okHooks()` 同源（参考 `src/__tests__/unit/graph-builder.test.ts`）；初始 state 用 `MemorySaver` 或空 object 视现有调用模式而定。

- [ ] **Step 2: Run 看 pass**

Run: `npx vitest run src/__tests__/integration/switch-routing-e2e.test.ts`
Expected: PASS（3 个场景全绿）

- [ ] **Step 3: Run 全套测试不退化**

Run: `npx vitest run`
Expected: 所有现有测试 + 本次新加测试全 PASS

- [ ] **Step 4: Commit**

```bash
git add src/__tests__/integration/switch-routing-e2e.test.ts
git commit -m "test(integration): switch routing e2e 三场景（命中/default/JSON 失败）"
```

---

## Verification（端到端验证手册）

实施完成后按以下顺序验证全套功能：

1. **后端单测全绿：** `npx vitest run`
2. **前端编译通过：** `cd web && pnpm build`
3. **DB migration 已落地：** `pnpm migrate` → 控制台显示 v44 已执行；查 `SELECT * FROM pipeline_node_types WHERE key='switch'` 应有 1 行
4. **Backend 可启：** `pnpm dev` → 无启动错误
5. **画布手动 smoke：**
   - `cd web && pnpm dev`，浏览器开 pipeline 编辑器
   - 拖一个 llm_agent 节点 → 选它 → outputFormat Radio 默认 'JSON'
   - 拖一个 switch 节点 → 节点显示菱形紫底 + ✦ + 双 source handle（底部居中 cases，底部右侧 default）
   - 从 switch 普通 source handle 拖 3 条线到 3 个下游节点 → 节点 `cases` 计数 = 3，每条 edge 标签 `case#1/2/3`
   - 从 switch default handle 拖一条线到第 4 个节点 → edge 紫色 `default` 标签，switch 节点显示 `default ✓`
   - 再拖一次 default 到第 5 个节点 → 旧 default 边自动删除（互斥）
   - 右键 case#2 edge → 编辑 when 表达式 `steps.q.output.score > 80` → 保存 → 选 switch 节点查看 params.cases[1].when 已写入
   - 右键 case 边的「↑ 上移」按钮 → 画布上 case 标签顺序重排
   - 右键 default edge → Alert 提示无表达式编辑
   - 删除某条 case edge → switch 节点 cases 计数 -1，params.cases 数组对应项消失
   - 保存 pipeline → 后端 graph-validation 通过
6. **运行时 smoke：** 触发该 pipeline，观察 LLM 节点产出 JSON 后 switch 正确路由（看 `pipeline_runs.stage_results` 列）
7. **回归保护：**
   - 旧白名单语法 pipeline（migration 前已存在，含 `status === 'success'` 等）经 v44 应自动归一化（`SELECT graph FROM test_pipelines WHERE ...` 验证）
   - 旧 llm_agent 节点 outputFormat 应为 'string'（行为不变）

---

## 风险与缓解

| 风险 | 缓解 |
|-----|------|
| 旧 llm_agent 节点（无 outputFormat）在 migration 前/后短暂窗口默认走 'json' 吃错 | v44 在 deploy 前先于代码上线；如反向滚动顺序无法保证，graph-builder 默认 fallback 改 'string' 直到 migration 完成（但与 spec 决策矛盾，v1 不取） |
| switch 双 source handle 视觉位置与 React Flow Handle 计算冲突 | clip-path 菱形 + Handle `style.left` 百分比定位 Step 1 dev smoke 时确认；如显示异常退回纯 SVG `<polygon>` 渲染 |
| 用户误把普通节点的边接到 switch 节点（switch 是 target）时，前端不应试图当 case 处理 | sync 逻辑只看 `e.source === switchId`；switch 作为 target 的边走普通 condition 编辑路径 |
| 集成测试 hooks 接口与现有 okHooks 不兼容 | Task 14 落地时优先复用 `src/__tests__/unit/graph-builder.test.ts` 已有 helper |
| Default handle 互斥逻辑与 React Flow 默认 onConnect 行为冲突 | onConnect 实现里**先过滤旧 default 再 addEdge**，确保互斥发生在 React Flow 状态更新前 |

---

## 实施次序总结

```
Task 1 (types) → Task 2 (switch executor) → Task 3 (dispatcher) → Task 4 (router 特化)
                                                                       │
Task 5 (conditionMatches 升级) ←──────────────────────────────────────┘
                  │
Task 6 (buildCapabilityNode JSON.parse)
                  │
Task 7 (graph-validation §5)
                  │
Task 8 (schema-v44 migration)
                  │
                  ├── Task 9-13（前端，可与后端 Task 1-8 并行，但需 Task 1 已 commit）
                  │
                  └── Task 14（集成测试，等 Task 1-9 全部完成）
```

每个 Task 在自己的 commit 内，主分支可在任何 Task 边界停下不破坏流水线。

---

## 备注：Plan 文件落地

按写作约定 plan 终稿应 commit 到 `docs/superpowers/plans/2026-04-27-pipeline-switch-node-design.md`（与同日期 spec 配套）。当前 plan 在 `/Users/yan/.claude/plans/snazzy-wandering-blossom.md` 是 plan mode 工作副本，批准后由用户复制到目标位置（或在 Task 0 / Step 0 由实施者复制）。

