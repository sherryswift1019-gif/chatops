# 画布节点配置面板下拉化与数据流打通 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把画布节点配置面板的 capabilityKey 手写输入改成下拉，为 capability 节点加 capabilityParams 动态表单，打通 `state.runtimeVars → capability` 数据流，并在前后端同步加必填校验。

**Architecture:** 前后端分头推进：后端改 `resolveCapabilityParams` / `buildCapabilityNode` / `validatePipelineGraph` 三处；前端改 `PipelineCanvasPage` 多拉一个 `/capabilities`，`NodeInspector` 按 stageType 渲染 Select + 动态 Form，切换时弹框清理。四个独立提交，每步 TDD。

**Tech Stack:** TypeScript (strict, ESM NodeNext)、Fastify、PostgreSQL、Vitest、React 18、Ant Design 5、@xyflow/react、@langchain/langgraph。

**Spec:** `docs/superpowers/specs/2026-04-22-pipeline-canvas-inspector-dropdown-design.md`

---

## Commit 1 · 后端：打通 runtimeVars 到 capability 节点

### Task 1.1: 扩展 resolveCapabilityParams —— 写失败测试

**Files:**
- Create: `src/__tests__/unit/resolve-capability-params.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { resolveCapabilityParams } from '../../pipeline/executor-hooks.js'

describe('resolveCapabilityParams', () => {
  it('returns undefined when params is undefined', () => {
    expect(resolveCapabilityParams(undefined, undefined, undefined)).toBeUndefined()
  })

  it('leaves literal string values unchanged', () => {
    const out = resolveCapabilityParams({ ref: 'main' }, undefined, undefined)
    expect(out).toEqual({ ref: 'main' })
  })

  it('resolves {{triggerParams.x}} to trigger param value, preserving type', () => {
    const out = resolveCapabilityParams(
      { ref: '{{triggerParams.branch}}', num: '{{triggerParams.count}}' },
      { branch: 'main', count: 42 },
      undefined,
    )
    expect(out).toEqual({ ref: 'main', num: 42 })
  })

  it('resolves {{vars.x}} from runtimeVars, preserving non-string types', () => {
    const out = resolveCapabilityParams(
      { ref: '{{vars.branch}}', flag: '{{vars.enabled}}', obj: '{{vars.payload}}' },
      undefined,
      { branch: 'main', enabled: true, payload: { a: 1 } },
    )
    expect(out).toEqual({ ref: 'main', flag: true, obj: { a: 1 } })
  })

  it('triggerParams takes precedence over vars when both keys collide', () => {
    const out = resolveCapabilityParams(
      { a: '{{triggerParams.a}}', b: '{{vars.a}}' },
      { a: 'from-trigger' },
      { a: 'from-vars' },
    )
    expect(out).toEqual({ a: 'from-trigger', b: 'from-vars' })
  })

  it('unresolved {{vars.x}} keeps the literal template', () => {
    const out = resolveCapabilityParams({ ref: '{{vars.missing}}' }, undefined, {})
    expect(out).toEqual({ ref: '{{vars.missing}}' })
  })

  it('embedded templates (non-whole-string match) are left as literal for v1', () => {
    const out = resolveCapabilityParams(
      { url: 'https://host/{{vars.path}}' },
      undefined,
      { path: 'abc' },
    )
    expect(out).toEqual({ url: 'https://host/{{vars.path}}' })
  })

  it('non-string values pass through untouched', () => {
    const out = resolveCapabilityParams({ count: 1, arr: [1, 2], obj: { x: 1 } }, undefined, undefined)
    expect(out).toEqual({ count: 1, arr: [1, 2], obj: { x: 1 } })
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```
pnpm vitest run src/__tests__/unit/resolve-capability-params.test.ts
```

Expected: FAIL —— `resolveCapabilityParams` 未导出 / 签名不匹配。

### Task 1.2: 扩展 resolveCapabilityParams —— 实现

**Files:**
- Modify: `src/pipeline/executor-hooks.ts:23-40`

- [ ] **Step 1: 把 resolveCapabilityParams 导出并扩展签名**

替换 `src/pipeline/executor-hooks.ts` 第 23–40 行的 `resolveCapabilityParams` 函数为：

```ts
/**
 * Resolve capability param templates to real values.
 *
 * 整值替换（whole-string 匹配）：保留原类型。
 *   - {{triggerParams.xxx}} → triggerParams[xxx]
 *   - {{vars.xxx}}          → runtimeVars[xxx]
 *
 * 嵌入式模板（非整值匹配）、未匹配的模板：保留字面字符串。
 *
 * Exported for unit testing.
 */
export function resolveCapabilityParams(
  params: Record<string, unknown> | undefined,
  triggerParams: Record<string, unknown> | undefined,
  runtimeVars: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!params) return params
  const resolved: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string') {
      const triggerMatch = value.match(/^\{\{triggerParams\.(\w+)\}\}$/)
      if (triggerMatch) {
        resolved[key] =
          triggerParams && triggerMatch[1] in triggerParams
            ? triggerParams[triggerMatch[1]]
            : value
        continue
      }
      const varsMatch = value.match(/^\{\{vars\.(\w+)\}\}$/)
      if (varsMatch) {
        resolved[key] =
          runtimeVars && varsMatch[1] in runtimeVars
            ? runtimeVars[varsMatch[1]]
            : value
        continue
      }
      resolved[key] = value
    } else {
      resolved[key] = value
    }
  }
  return resolved
}
```

- [ ] **Step 2: 运行测试确认通过**

```
pnpm vitest run src/__tests__/unit/resolve-capability-params.test.ts
```

Expected: PASS 8/8。

### Task 1.3: 扩展 StageHooks.runCapability 签名

**Files:**
- Modify: `src/pipeline/graph-builder.ts:16-27`（`StageHooks` interface）
- Modify: `src/pipeline/graph-builder.ts:211-237`（`buildCapabilityNode`）
- Modify: `src/pipeline/executor-hooks.ts:133-168`（默认 hook 实现）

- [ ] **Step 1: 修改 StageHooks 接口**

把 `src/pipeline/graph-builder.ts` 第 16–27 行的 `StageHooks` 中 `runCapability` 的签名改为：

```ts
runCapability(
  stage: StageDefinition,
  ctx: StageContext,
  triggerParams?: Record<string, unknown>,
  runtimeVars?: Record<string, unknown>,
): Promise<StageExecutionResult>
```

- [ ] **Step 2: buildCapabilityNode 从 state 读 runtimeVars**

把 `src/pipeline/graph-builder.ts:211-237` 的 `buildCapabilityNode` 整个函数替换为：

```ts
function buildCapabilityNode(
  stage: StageDefinition,
  index: number,
  ctxBase: StageContextBase,
  hooks: StageHooks,
  triggerParams?: Record<string, unknown>,
) {
  return async (state: typeof PipelineStateAnnotation.State) => {
    const startedAt = nowIso()
    const startedMs = Date.now()
    const ctx: StageContext = { ...ctxBase, stageIndex: index }
    const runtimeVars = state.runtimeVars
    let exec: StageExecutionResult
    try {
      exec = await hooks.runCapability(stage, ctx, triggerParams, runtimeVars)
    } catch (err) {
      exec = {
        status: 'failed',
        output: `capability hook error: ${String(err)}`,
        error: String(err),
      }
    }
    return {
      currentStageIndex: index,
      stageResults: finishedResult(stage, startedAt, startedMs, exec),
    }
  }
}
```

- [ ] **Step 3: 默认 hook 把 runtimeVars 传进 resolveCapabilityParams**

把 `src/pipeline/executor-hooks.ts:133` 行起的 `runCapability` 函数替换为：

```ts
async runCapability(stage, ctx, triggerParams, runtimeVars): Promise<StageExecutionResult> {
  const capabilityKey = stage.capabilityKey
  if (!capabilityKey) {
    return { status: 'failed', output: '未配置 capabilityKey', error: 'no capabilityKey' }
  }
  const timeoutMs = (stage.timeoutSeconds ?? 1200) * 1000
  const resolvedParams = resolveCapabilityParams(
    stage.capabilityParams,
    triggerParams,
    runtimeVars,
  )
  try {
    const capabilityPromise = triggerCapability({
      capabilityKey,
      context: {
        taskId: `pipeline-${ctx.runId}-stage-${ctx.stageIndex}`,
        groupId: 'pipeline',
        platform: 'pipeline',
        initiatorId: 'pipeline-executor',
        initiatorRole: 'admin',
      },
      extraParams: resolvedParams,
    })
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('capability 执行超时')), timeoutMs),
    )
    const result = await Promise.race([capabilityPromise, timeoutPromise])
    return {
      status: result.success ? 'success' : 'failed',
      output: result.output ?? '',
      error: result.error,
    }
  } catch (err) {
    return {
      status: 'failed',
      output: `capability 执行失败: ${String(err)}`,
      error: String(err),
    }
  }
},
```

- [ ] **Step 4: 运行整套流水线测试确认无回归**

```
pnpm vitest run src/__tests__/unit/graph-builder.test.ts src/__tests__/unit/graph-runner.test.ts src/__tests__/unit/pipeline
```

Expected: ALL PASS —— 所有现有测试向后兼容（新增的 `runtimeVars` 参数可选，旧 hooks 不传也可）。

### Task 1.4: 端到端测试：im_input → capability 通过 runtimeVars 传值

**Files:**
- Create: `src/__tests__/unit/pipeline/im-capability-runtime-vars.test.ts`

- [ ] **Step 1: 写端到端测试**

```ts
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { MemorySaver, Command } from '@langchain/langgraph'
import {
  buildGraphFromStages,
  type StageHooks,
  type BuildGraphInput,
} from '../../../pipeline/graph-builder.js'
import type {
  StageDefinition,
  StageExecutionResult,
  StageContext,
  ServerInfo,
} from '../../../pipeline/types.js'

function makeStage(
  partial: Partial<StageDefinition> & Pick<StageDefinition, 'name' | 'stageType'>,
): StageDefinition {
  return {
    targetRoles: [],
    parallel: false,
    timeoutSeconds: 60,
    retryCount: 0,
    onFailure: 'stop',
    ...partial,
  }
}

function baseCtx(overrides: Partial<Omit<StageContext, 'stageIndex'>> = {}) {
  return {
    runId: 1,
    servers: {} as Record<string, ServerInfo[]>,
    logDir: '/tmp/chatops-runtime-vars-test',
    triggerPlatform: 'test',
    triggerGroupId: 'g1',
    ...overrides,
  }
}

function compile(input: BuildGraphInput) {
  const g = buildGraphFromStages(input)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (g as any).compile({ checkpointer: new MemorySaver() })
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) { /* drain */ }
}

describe('im_input → capability: runtimeVars 打通', () => {
  it('im_input 采集的 branch 通过 {{vars.branch}} 传到 capability hook', async () => {
    const stages: StageDefinition[] = [
      makeStage({
        name: 'collect',
        stageType: 'im_input',
        imInputConfig: {
          prompt: '请提供 branch',
          paramSchema: {
            type: 'object',
            required: ['branch'],
            properties: { branch: { type: 'string' } },
          },
          timeoutSeconds: 60,
        },
      }),
      makeStage({
        name: 'deploy',
        stageType: 'capability',
        capabilityKey: 'build',
        capabilityParams: { ref: '{{vars.branch}}' },
      }),
    ]

    const capturedParams: Array<Record<string, unknown> | undefined> = []
    const hooks: StageHooks = {
      async runScript() { return { status: 'success', output: '' } },
      async runCapability(_stage, _ctx, _trigger, runtimeVars) {
        const resolved = { ref: (runtimeVars as { branch?: string } | undefined)?.branch }
        capturedParams.push(resolved)
        return { status: 'success', output: JSON.stringify(resolved) }
      },
    }

    const graph = compile({ stages, stageContext: baseCtx(), hooks })
    const config = { configurable: { thread_id: randomUUID() } }
    await drain(await graph.stream({ runId: 1 }, config))
    // resume im_input with user message providing branch=main
    await drain(await graph.stream(new Command({ resume: 'branch=main' }), config))

    const snap = await graph.getState(config)
    expect(snap.values.runtimeVars.branch).toBe('main')
    expect(snap.values.stageResults.at(-1).status).toBe('success')
  })
})
```

- [ ] **Step 2: 运行测试确认通过**

```
pnpm vitest run src/__tests__/unit/pipeline/im-capability-runtime-vars.test.ts
```

Expected: PASS 1/1。

> 说明：测试里 hook 自己手动读 `runtimeVars.branch`，因为单测 hook 不走默认 `buildDefaultHooks`；第 1.2 任务已经在 `buildDefaultHooks` 里把 `resolveCapabilityParams` 接上了 runtimeVars，这里只验证 graph 把 state.runtimeVars 传到 hook 的契约。

### Task 1.5: 补充约定文档

**Files:**
- Modify: `src/pipeline/variables.ts:1-8`（顶部注释）

- [ ] **Step 1: 追加模板约定 JSDoc**

把 `src/pipeline/variables.ts` 开头的 `export interface VariableContext` 之前插入：

```ts
/**
 * 变量模板约定（script 与 capability 节点语义统一）
 *
 * - `{{vars.xxx}}`：读取 `state.runtimeVars`（由 im_input / wait_webhook
 *   节点写入）与 `pipeline.variables`（流水线配置自定义变量）的合并值。
 *   script 节点走 resolveVariables（本文件），capability 节点走
 *   resolveCapabilityParams（src/pipeline/executor-hooks.ts）。
 * - `{{triggerParams.xxx}}`：仅 capability 节点识别，读取流水线触发时
 *   透传的 triggerParams。
 * - 未匹配的模板：保留字面字符串。
 *
 * capability 第一版仅支持整值替换（^{{...}}$），不支持嵌入式模板
 * （如 "foo-{{vars.x}}"）。
 */
```

### Task 1.6: Commit 1

- [ ] **Step 1: 提交**

```bash
git add src/pipeline/executor-hooks.ts src/pipeline/graph-builder.ts src/pipeline/variables.ts \
  src/__tests__/unit/resolve-capability-params.test.ts \
  src/__tests__/unit/pipeline/im-capability-runtime-vars.test.ts
git commit -m "$(cat <<'EOF'
feat(pipeline): 打通 runtimeVars → capability 节点

- resolveCapabilityParams 新增 {{vars.xxx}} 整值解析（保留原类型）
- buildCapabilityNode 从 state.runtimeVars 读取并透传给 hook
- StageHooks.runCapability 签名新增可选 runtimeVars 参数（向后兼容）
- variables.ts 新增模板约定注释

im_input / wait_webhook 采集/接收的数据现在可以被下游 capability 节点
通过 {{vars.xxx}} 引用。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Commit 2 · 后端：graph-validation 必填校验

### Task 2.1: 扩展 graph-validation —— 写失败测试

**Files:**
- Modify: `src/__tests__/unit/graph-validation.test.ts`（如不存在则 Create）

- [ ] **Step 1: 确认文件是否存在**

```
ls src/__tests__/unit/graph-validation.test.ts 2>/dev/null || echo "NOT EXIST"
```

如果输出 "NOT EXIST"，Step 2 用 Create；否则用 Modify（在文件底部追加）。

- [ ] **Step 2: 写新增必填用例测试**

追加到 `src/__tests__/unit/graph-validation.test.ts`（若不存在则新建文件，开头加 imports）：

```ts
import { describe, it, expect } from 'vitest'
import { validatePipelineGraph } from '../../pipeline/graph-validation.js'
import type { PipelineGraph, PipelineNode } from '../../pipeline/types.js'

function node(partial: Partial<PipelineNode> & Pick<PipelineNode, 'id' | 'name' | 'stageType'>): PipelineNode {
  return {
    targetRoles: [],
    parallel: false,
    timeoutSeconds: 60,
    retryCount: 0,
    onFailure: 'stop',
    position: { x: 0, y: 0 },
    ...partial,
  }
}

describe('validatePipelineGraph — 按 stageType 必填校验', () => {
  it('capability 节点缺 capabilityKey → 报错', () => {
    const graph: PipelineGraph = {
      nodes: [node({ id: 'n1', name: 'cap', stageType: 'capability' })],
      edges: [],
    }
    const r = validatePipelineGraph(graph)
    expect(r.ok).toBe(false)
    expect(r.errors.some(e => e.includes('n1') && e.includes('capabilityKey'))).toBe(true)
  })

  it('capability 节点有 capabilityKey → 通过', () => {
    const graph: PipelineGraph = {
      nodes: [node({ id: 'n1', name: 'cap', stageType: 'capability', capabilityKey: 'build' })],
      edges: [],
    }
    expect(validatePipelineGraph(graph).ok).toBe(true)
  })

  it('wait_webhook 节点缺 webhookTag → 报错', () => {
    const graph: PipelineGraph = {
      nodes: [node({ id: 'n1', name: 'w', stageType: 'wait_webhook' })],
      edges: [],
    }
    const r = validatePipelineGraph(graph)
    expect(r.ok).toBe(false)
    expect(r.errors.some(e => e.includes('n1') && e.includes('webhookTag'))).toBe(true)
  })

  it('im_input 节点缺 imInputConfig.prompt → 报错', () => {
    const graph: PipelineGraph = {
      nodes: [
        node({
          id: 'n1',
          name: 'i',
          stageType: 'im_input',
          imInputConfig: {
            prompt: '',
            paramSchema: { type: 'object', properties: {} },
          },
        }),
      ],
      edges: [],
    }
    const r = validatePipelineGraph(graph)
    expect(r.ok).toBe(false)
    expect(r.errors.some(e => e.includes('n1') && e.includes('prompt'))).toBe(true)
  })

  it('im_input 节点 paramSchema 非 object → 报错', () => {
    const graph: PipelineGraph = {
      nodes: [
        node({
          id: 'n1',
          name: 'i',
          stageType: 'im_input',
          imInputConfig: {
            prompt: '请输入',
            paramSchema: 'not-an-object' as unknown as Record<string, unknown>,
          },
        }),
      ],
      edges: [],
    }
    const r = validatePipelineGraph(graph)
    expect(r.ok).toBe(false)
    expect(r.errors.some(e => e.includes('n1') && e.includes('paramSchema'))).toBe(true)
  })

  it('approval 节点缺 approverIds → 报错', () => {
    const graph: PipelineGraph = {
      nodes: [node({ id: 'n1', name: 'a', stageType: 'approval' })],
      edges: [],
    }
    const r = validatePipelineGraph(graph)
    expect(r.ok).toBe(false)
    expect(r.errors.some(e => e.includes('n1') && e.includes('approverIds'))).toBe(true)
  })

  it('approval 节点 approverIds 是空数组 → 报错', () => {
    const graph: PipelineGraph = {
      nodes: [node({ id: 'n1', name: 'a', stageType: 'approval', approverIds: [] })],
      edges: [],
    }
    expect(validatePipelineGraph(graph).ok).toBe(false)
  })

  it('script 节点脚本为空 → 通过（允许占位）', () => {
    const graph: PipelineGraph = {
      nodes: [node({ id: 'n1', name: 's', stageType: 'script' })],
      edges: [],
    }
    expect(validatePipelineGraph(graph).ok).toBe(true)
  })
})
```

- [ ] **Step 3: 运行测试确认失败**

```
pnpm vitest run src/__tests__/unit/graph-validation.test.ts
```

Expected: 多处 FAIL（现有 validator 不报 stageType 必填）。

### Task 2.2: 扩展 validatePipelineGraph 实现

**Files:**
- Modify: `src/pipeline/graph-validation.ts`

- [ ] **Step 1: 扩展 validator，添加 stageType 必填检查**

在 `src/pipeline/graph-validation.ts` 第 16 行起的 `validatePipelineGraph` 函数的开头（遍历 node 那段之前）追加一个辅助函数，然后在遍历里调用它。

把整个函数体替换为：

```ts
export function validatePipelineGraph(graph: PipelineGraph): ValidationResult {
  const errors: string[] = []
  const nodeIds = new Set<string>()
  for (const n of graph.nodes) {
    if (nodeIds.has(n.id)) errors.push(`duplicate node id: ${n.id}`)
    nodeIds.add(n.id)
    const fieldError = checkRequiredFields(n)
    if (fieldError) errors.push(fieldError)
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
      if (c === 1) return true
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

function checkRequiredFields(n: PipelineGraph['nodes'][number]): string | null {
  const prefix = `node ${n.id} (stageType=${n.stageType})`
  switch (n.stageType) {
    case 'capability':
      if (!n.capabilityKey || !n.capabilityKey.trim()) {
        return `${prefix}: capabilityKey is required`
      }
      return null
    case 'wait_webhook':
      if (!n.webhookTag || !n.webhookTag.trim()) {
        return `${prefix}: webhookTag is required`
      }
      return null
    case 'im_input': {
      const cfg = n.imInputConfig
      if (!cfg || !cfg.prompt || !cfg.prompt.trim()) {
        return `${prefix}: imInputConfig.prompt is required`
      }
      if (
        typeof cfg.paramSchema !== 'object' ||
        cfg.paramSchema === null ||
        Array.isArray(cfg.paramSchema)
      ) {
        return `${prefix}: imInputConfig.paramSchema must be an object`
      }
      return null
    }
    case 'approval':
      if (!Array.isArray(n.approverIds) || n.approverIds.length === 0) {
        return `${prefix}: approverIds is required (non-empty array)`
      }
      return null
    case 'script':
      return null
    default:
      return null
  }
}
```

- [ ] **Step 2: 确认 import 完整**

确认 `src/pipeline/graph-validation.ts` 顶部 import 为：

```ts
import type { PipelineGraph } from './types.js'
```

不需要新增 import（`checkRequiredFields` 用的都是 node 自身字段）。

- [ ] **Step 3: 运行测试确认通过**

```
pnpm vitest run src/__tests__/unit/graph-validation.test.ts
```

Expected: ALL PASS。

- [ ] **Step 4: 跑全量测试确保无回归**

```
pnpm test
```

Expected: ALL PASS。如果某些现有 graph fixture 没填 capabilityKey / approverIds 等字段导致新增校验失败，补齐 fixture（不要放宽校验）。

### Task 2.3: Commit 2

- [ ] **Step 1: 提交**

```bash
git add src/pipeline/graph-validation.ts src/__tests__/unit/graph-validation.test.ts
git commit -m "$(cat <<'EOF'
feat(pipeline): graph-validation 新增 stageType 必填校验

- capability → capabilityKey 非空
- wait_webhook → webhookTag 非空
- im_input → imInputConfig.prompt 非空、paramSchema 必须是 object
- approval → approverIds 非空数组
- script → 允许空（保留占位语义）

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Commit 3 · 前端：capabilityKey 下拉 + stale 兼容

### Task 3.1: PipelineCanvasPage 加载 capabilities

**Files:**
- Modify: `web/src/pipeline-canvas/PipelineCanvasPage.tsx`

- [ ] **Step 1: 新增 import**

在 `web/src/pipeline-canvas/PipelineCanvasPage.tsx:8` 之后加入：

```ts
import { getCapabilities, type Capability } from '../api/capabilities'
```

- [ ] **Step 2: 新增 capabilities state 类型**

在 `PipelineCanvasPage` 函数组件里，`const [availableRoles, setAvailableRoles] = useState<string[]>([])` 之后插入：

```ts
const [capabilityOptions, setCapabilityOptions] = useState<CapabilityOption[]>([])
```

并在文件顶部（`import type { StageType, StageFields } from './types'` 之后）加入：

```ts
export interface CapabilityOption {
  key: string
  displayName: string
  category: Capability['category']
  paramSchema: Record<string, unknown>
}
```

- [ ] **Step 3: Promise.all 里加入 getCapabilities**

把 `PipelineCanvasPage.tsx` 中 `Promise.all([...])` 改为：

```ts
const [p, cat, usersRes, wire, caps] = await Promise.all([
  getTestPipeline(pipelineId),
  getPipelineVariables(),
  getDingTalkUsers(),
  getPipelineGraph(pipelineId),
  getCapabilities(),
])
```

并在 `if (cancelled) return` 后的 setState 块里追加：

```ts
setCapabilityOptions(
  caps.map(c => ({
    key: c.key,
    displayName: c.displayName,
    category: c.category,
    paramSchema: c.paramSchema ?? {},
  })),
)
```

- [ ] **Step 4: 把 capabilityOptions 传给 NodeInspector**

把 `<NodeInspector ... />` 调用修改为包含新 prop：

```tsx
<NodeInspector
  node={selectedNode}
  onClose={() => setSelectedId(null)}
  onChange={graph.updateNodeData}
  availableRoles={availableRoles}
  dingtalkUsers={dingtalkUsers}
  capabilities={capabilityOptions}
/>
```

### Task 3.2: NodeInspector 改 capability / im_input 下拉

**Files:**
- Modify: `web/src/pipeline-canvas/panels/NodeInspector.tsx`

- [ ] **Step 1: 修改 Props 接口与 imports**

把 `NodeInspector.tsx` 文件顶部的 imports 和 `interface Props` 改为：

```tsx
import { Drawer, Form, Input, InputNumber, Select, Switch, Alert, Tag, Tooltip } from 'antd'
import { ExclamationCircleTwoTone } from '@ant-design/icons'
import { useEffect, useState } from 'react'
import type { StageNode, StageFields, ImInputConfig } from '../types'
import type { CapabilityOption } from '../PipelineCanvasPage'

interface Props {
  node: StageNode | null
  onClose: () => void
  onChange: (id: string, data: Partial<StageFields>) => void
  availableRoles: string[]
  dingtalkUsers: { userId: string; name: string }[]
  capabilities: CapabilityOption[]
}
```

并把函数签名改为：

```tsx
export function NodeInspector({ node, onClose, onChange, availableRoles, dingtalkUsers, capabilities }: Props) {
```

- [ ] **Step 2: 新增 capability Select 渲染辅助**

在 `NodeInspector.tsx` 文件内 `const DEFAULT_SCHEMA` 之后加入：

```tsx
function capabilityOptions(list: CapabilityOption[], currentKey?: string) {
  const known = new Set(list.map(c => c.key))
  const opts = list.map(c => ({
    value: c.key,
    label: (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div>{c.displayName}</div>
          <div style={{ fontSize: 11, color: '#999' }}>{c.key}</div>
        </div>
        <Tag>{c.category}</Tag>
      </div>
    ),
    key: c.key,
    searchText: `${c.displayName} ${c.key}`,
  }))
  if (currentKey && !known.has(currentKey)) {
    opts.unshift({
      value: currentKey,
      label: (
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <ExclamationCircleTwoTone twoToneColor="#faad14" style={{ marginRight: 6 }} />
          <span>{currentKey}（不在能力列表中）</span>
        </div>
      ),
      key: currentKey,
      searchText: currentKey,
    })
  }
  return opts
}
```

- [ ] **Step 3: 替换 capability 分支的 Input 为 Select**

把 `NodeInspector.tsx` 中 `if (t === 'capability') return (...)` 分支替换为：

```tsx
if (t === 'capability') return (
  <Form.Item
    name="capabilityKey"
    label="Capability"
    rules={[{ required: true, message: '请选择 Capability' }]}
  >
    <Select
      showSearch
      placeholder="选择一个 Agent Capability"
      options={capabilityOptions(capabilities, node!.data.capabilityKey)}
      filterOption={(input, opt) => {
        const t = (opt as { searchText?: string } | undefined)?.searchText ?? ''
        return t.toLowerCase().includes(input.toLowerCase())
      }}
    />
  </Form.Item>
)
```

- [ ] **Step 4: 替换 im_input 的 capabilityKey 输入为 Select**

把 `if (t === 'im_input') return (...)` 分支内 `imInputConfig.capabilityKey` 的 Form.Item 替换为：

```tsx
<Form.Item name={['imInputConfig', 'capabilityKey']} label="关联 Capability（可选）">
  <Select
    allowClear
    showSearch
    placeholder="留空即可；用于增强 IM 参数判定的上下文"
    options={capabilityOptions(capabilities, node!.data.imInputConfig?.capabilityKey)}
    filterOption={(input, opt) => {
      const t = (opt as { searchText?: string } | undefined)?.searchText ?? ''
      return t.toLowerCase().includes(input.toLowerCase())
    }}
  />
</Form.Item>
```

- [ ] **Step 5: 运行前端构建，验证类型通过**

```
cd web && pnpm build
```

Expected: `tsc -b && vite build` 成功无错误。

### Task 3.3: Commit 3

- [ ] **Step 1: 提交**

```bash
git add web/src/pipeline-canvas/PipelineCanvasPage.tsx web/src/pipeline-canvas/panels/NodeInspector.tsx
git commit -m "$(cat <<'EOF'
feat(pipeline-canvas): capabilityKey 改下拉选择

- PipelineCanvasPage 初始加载 /capabilities
- capability 节点的 capabilityKey 改为 Select（必填、可搜索）
- im_input 节点的 capabilityKey 改为 Select（可选）
- option 展示 displayName + key + category tag
- 保留的 stale key（capability 已删）显示 warning 图标，允许保留

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Commit 4 · 前端：capabilityParams 动态表单 + stageType 切换 + 其它 UX

### Task 4.1: 抽离 pruneStageFields 纯函数 + 单测

**Files:**
- Create: `web/src/pipeline-canvas/panels/pruneStageFields.ts`
- Create: `web/src/pipeline-canvas/panels/pruneStageFields.test.ts`

- [ ] **Step 1: 写纯函数**

```ts
import type { StageFields, StageType } from '../types'

/**
 * 切换 stageType 时清理旧类型独有字段：返回新的 StageFields。
 *
 * 共享字段（name / targetRoles / parallel / timeoutSeconds / retryCount /
 * onFailure / stageType）保留；每种 stageType 独占字段（script / approverIds /
 * approvalDescription / capabilityKey / capabilityParams / webhookTag /
 * imInputConfig）被清空，新类型按默认值注入。
 */
export function pruneStageFields(prev: StageFields, newType: StageType): StageFields {
  const base: StageFields = {
    id: prev.id,
    name: prev.name,
    stageType: newType,
    targetRoles: prev.targetRoles,
    parallel: prev.parallel,
    timeoutSeconds: prev.timeoutSeconds,
    retryCount: prev.retryCount,
    onFailure: prev.onFailure,
  }
  switch (newType) {
    case 'script':
      return { ...base, script: '' }
    case 'approval':
      return { ...base, approverIds: [], approvalDescription: '' }
    case 'capability':
      return { ...base, capabilityKey: '', capabilityParams: {} }
    case 'wait_webhook':
      return { ...base, webhookTag: '' }
    case 'im_input':
      return {
        ...base,
        imInputConfig: {
          prompt: '请提供以下参数：',
          paramSchema: { type: 'object', properties: {}, required: [] },
          timeoutSeconds: 600,
        },
      }
  }
}

/**
 * 列出 prev 里已填、不属于 newType 独占字段的 field 名称（用于弹框提示）。
 */
export function obsoleteFieldsOnSwitch(prev: StageFields, newType: StageType): string[] {
  const fieldsByType: Record<StageType, (keyof StageFields)[]> = {
    script: ['script'],
    approval: ['approverIds', 'approvalDescription'],
    capability: ['capabilityKey', 'capabilityParams'],
    wait_webhook: ['webhookTag'],
    im_input: ['imInputConfig'],
  }
  const obsolete: string[] = []
  for (const [type, fields] of Object.entries(fieldsByType) as [StageType, (keyof StageFields)[]][]) {
    if (type === newType) continue
    for (const f of fields) {
      if (!isEmpty(prev[f])) obsolete.push(String(f))
    }
  }
  return obsolete
}

function isEmpty(v: unknown): boolean {
  if (v == null) return true
  if (typeof v === 'string') return v.trim() === ''
  if (Array.isArray(v)) return v.length === 0
  if (typeof v === 'object') return Object.keys(v as Record<string, unknown>).length === 0
  return false
}
```

- [ ] **Step 2: 写单测**

```ts
import { describe, it, expect } from 'vitest'
import { pruneStageFields, obsoleteFieldsOnSwitch } from './pruneStageFields'
import type { StageFields } from '../types'

function base(type: StageFields['stageType'], extras: Partial<StageFields> = {}): StageFields {
  return {
    id: 'n1',
    name: 'n',
    stageType: type,
    targetRoles: [],
    parallel: false,
    timeoutSeconds: 300,
    retryCount: 0,
    onFailure: 'stop',
    ...extras,
  }
}

describe('pruneStageFields', () => {
  it('script → capability: 清掉 script，注入 capabilityKey/Params 默认值', () => {
    const prev = base('script', { script: 'echo hi' })
    const next = pruneStageFields(prev, 'capability')
    expect(next.script).toBeUndefined()
    expect(next.capabilityKey).toBe('')
    expect(next.capabilityParams).toEqual({})
    expect(next.stageType).toBe('capability')
    expect(next.name).toBe('n')  // 共享字段保留
  })

  it('approval → im_input: 清掉 approverIds，注入 imInputConfig 默认值', () => {
    const prev = base('approval', { approverIds: ['u1'], approvalDescription: 'ok' })
    const next = pruneStageFields(prev, 'im_input')
    expect(next.approverIds).toBeUndefined()
    expect(next.approvalDescription).toBeUndefined()
    expect(next.imInputConfig?.prompt).toBe('请提供以下参数：')
  })
})

describe('obsoleteFieldsOnSwitch', () => {
  it('prev 是 script(script="x") 切到 capability → 返回 [script]', () => {
    const prev = base('script', { script: 'x' })
    expect(obsoleteFieldsOnSwitch(prev, 'capability')).toEqual(['script'])
  })

  it('prev 是 capability(key/params 都填) 切到 script → 返回 [capabilityKey, capabilityParams]', () => {
    const prev = base('capability', { capabilityKey: 'build', capabilityParams: { a: 1 } })
    expect(obsoleteFieldsOnSwitch(prev, 'script').sort()).toEqual(['capabilityKey', 'capabilityParams'])
  })

  it('空值字段不计入 obsolete', () => {
    const prev = base('capability', { capabilityKey: '', capabilityParams: {} })
    expect(obsoleteFieldsOnSwitch(prev, 'script')).toEqual([])
  })
})
```

- [ ] **Step 3: 运行测试确认通过**

```
pnpm vitest run web/src/pipeline-canvas/panels/pruneStageFields.test.ts
```

Expected: ALL PASS。

### Task 4.2: NodeInspector 接入 stageType 切换弹框

**Files:**
- Modify: `web/src/pipeline-canvas/panels/NodeInspector.tsx`

- [ ] **Step 1: 新增 import**

把 NodeInspector.tsx 顶部 `import { Drawer, Form, ...`那一行加入 `Modal`：

```tsx
import { Drawer, Form, Input, InputNumber, Select, Switch, Alert, Tag, Modal } from 'antd'
```

以及新增：

```tsx
import { pruneStageFields, obsoleteFieldsOnSwitch } from './pruneStageFields'
```

- [ ] **Step 2: 在 stageType Form.Item 上接管 onChange**

把 `NodeInspector.tsx` 里的 `stageType` Form.Item 替换为：

```tsx
<Form.Item name="stageType" label="类型">
  <Select
    options={[
      { value: 'script', label: '运行脚本' },
      { value: 'approval', label: '人员审批' },
      { value: 'capability', label: 'Agent Capability' },
      { value: 'wait_webhook', label: '等待 Webhook' },
      { value: 'im_input', label: 'IM 参数采集' },
    ]}
    onChange={(newType) => handleStageTypeChange(newType)}
  />
</Form.Item>
```

并在 `handleValuesChange` 函数之后新增：

```tsx
function handleStageTypeChange(newType: StageFields['stageType']) {
  if (!node) return
  const obsolete = obsoleteFieldsOnSwitch(node.data, newType)
  if (obsolete.length === 0) {
    const pruned = pruneStageFields(node.data, newType)
    form.setFieldsValue(pruned)
    onChange(node.id, pruned)
    return
  }
  Modal.confirm({
    title: '切换类型将清空字段',
    content: `将清空：${obsolete.join(', ')}。确认继续？`,
    okText: '确认切换',
    cancelText: '取消',
    onOk: () => {
      const pruned = pruneStageFields(node.data, newType)
      form.setFieldsValue(pruned)
      onChange(node.id, pruned)
    },
    onCancel: () => {
      form.setFieldsValue({ stageType: node.data.stageType })
    },
  })
}
```

- [ ] **Step 3: 前端构建确认无类型错误**

```
cd web && pnpm build
```

Expected: PASS。

### Task 4.3: targetRoles 按 stageType 条件显示

**Files:**
- Modify: `web/src/pipeline-canvas/panels/NodeInspector.tsx`

- [ ] **Step 1: targetRoles 改为 shouldUpdate 块内渲染**

把 `NodeInspector.tsx` 中 `<Form.Item name="targetRoles" ...>` 那块删掉，并把下方已有的 `shouldUpdate` 渲染块增加一段分支，使 script 独享 targetRoles：

在 `<Form.Item shouldUpdate={(p, c) => p.stageType !== c.stageType} noStyle>` 的 render function 的 `if (t === 'script') return (...)` 分支替换为：

```tsx
if (t === 'script') return (
  <>
    <Form.Item name="targetRoles" label="目标角色">
      <Select mode="multiple" options={availableRoles.map(r => ({ value: r, label: r }))} />
    </Form.Item>
    <Form.Item name="script" label="脚本">
      <Input.TextArea rows={8} style={{ fontFamily: 'monospace', fontSize: 12 }} />
    </Form.Item>
  </>
)
```

### Task 4.4: capabilityParams 动态表单

**Files:**
- Create: `web/src/pipeline-canvas/panels/CapabilityParamsForm.tsx`
- Modify: `web/src/pipeline-canvas/panels/NodeInspector.tsx`

- [ ] **Step 1: 新建 CapabilityParamsForm 组件**

```tsx
import { Form, Input, InputNumber, Select, Switch, Alert } from 'antd'
import { useEffect, useState } from 'react'

type Schema = Record<string, unknown>

interface Props {
  paramSchema: Schema | undefined
  value: Record<string, unknown> | undefined
  onChange: (next: Record<string, unknown>) => void
}

/**
 * 按 JSON Schema（仅支持 type=object, properties 扁平层）动态渲染表单。
 * 复杂类型 fallback 到 JSON TextArea。
 */
export function CapabilityParamsForm({ paramSchema, value, onChange }: Props) {
  const properties = getProperties(paramSchema)
  const required = getRequired(paramSchema)

  // 非 object schema fallback 为整体 JSON TextArea
  if (!properties) {
    return <JsonFallback value={value} onChange={onChange} />
  }

  const entries = Object.entries(properties)
  if (entries.length === 0) {
    return <Alert type="info" showIcon message="该 Capability 未声明参数" />
  }

  return (
    <>
      <div style={{ fontWeight: 500, marginBottom: 8 }}>Capability 参数</div>
      {entries.map(([key, propRaw]) => {
        const prop = propRaw as Record<string, unknown>
        return (
          <Form.Item
            key={key}
            label={(prop.title as string | undefined) ?? key}
            required={required.includes(key)}
            rules={required.includes(key) ? [{ required: true, message: `${key} 必填` }] : []}
            extra={typeof prop.description === 'string' ? prop.description : undefined}
          >
            {renderControl(prop, value?.[key], (next) => onChange({ ...(value ?? {}), [key]: next }))}
          </Form.Item>
        )
      })}
      <div style={{ fontSize: 11, color: '#999', marginTop: 4 }}>
        字符串字段支持 {'{{vars.xxx}}'}（im_input/webhook 采集的值）、{'{{triggerParams.xxx}}'}（触发参数）
      </div>
    </>
  )
}

function renderControl(
  prop: Record<string, unknown>,
  val: unknown,
  onChange: (v: unknown) => void,
) {
  const t = prop.type as string | undefined
  const enumVals = prop.enum as unknown[] | undefined

  if (t === 'string' && enumVals) {
    return (
      <Select
        value={val as string | undefined}
        onChange={onChange}
        options={enumVals.map(e => ({ value: String(e), label: String(e) }))}
        allowClear
      />
    )
  }
  if (t === 'string') {
    return (
      <Input
        value={val as string | undefined}
        onChange={e => onChange(e.target.value)}
        placeholder={typeof prop.description === 'string' ? prop.description : undefined}
      />
    )
  }
  if (t === 'number' || t === 'integer') {
    return (
      <InputNumber
        value={val as number | undefined}
        onChange={v => onChange(v)}
        min={prop.minimum as number | undefined}
        max={prop.maximum as number | undefined}
      />
    )
  }
  if (t === 'boolean') {
    return <Switch checked={!!val} onChange={onChange} />
  }
  // 数组/对象/其它：JSON TextArea
  return <JsonField value={val} onChange={onChange} />
}

function JsonField({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const [text, setText] = useState(() => JSON.stringify(value ?? null, null, 2))
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    setText(JSON.stringify(value ?? null, null, 2))
  }, [value])
  return (
    <>
      <Input.TextArea
        rows={4}
        value={text}
        onChange={e => setText(e.target.value)}
        onBlur={() => {
          try {
            onChange(JSON.parse(text))
            setErr(null)
          } catch (e) {
            setErr((e as Error).message)
          }
        }}
        style={{ fontFamily: 'monospace', fontSize: 12 }}
      />
      {err && <Alert type="error" showIcon style={{ marginTop: 4 }} message={err} />}
    </>
  )
}

function JsonFallback({
  value,
  onChange,
}: {
  value: Record<string, unknown> | undefined
  onChange: (v: Record<string, unknown>) => void
}) {
  const [text, setText] = useState(() => JSON.stringify(value ?? {}, null, 2))
  const [err, setErr] = useState<string | null>(null)
  return (
    <Form.Item label="capabilityParams (JSON)">
      <Input.TextArea
        rows={8}
        value={text}
        onChange={e => setText(e.target.value)}
        onBlur={() => {
          try {
            const parsed = JSON.parse(text)
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
              throw new Error('capabilityParams 必须是 object')
            }
            onChange(parsed)
            setErr(null)
          } catch (e) {
            setErr((e as Error).message)
          }
        }}
        style={{ fontFamily: 'monospace', fontSize: 12 }}
      />
      {err && <Alert type="error" showIcon style={{ marginTop: 4 }} message={err} />}
    </Form.Item>
  )
}

function getProperties(schema: Schema | undefined): Record<string, unknown> | null {
  if (!schema || typeof schema !== 'object') return null
  if ((schema as { type?: unknown }).type !== 'object') return null
  const props = (schema as { properties?: unknown }).properties
  if (typeof props !== 'object' || props === null) return null
  return props as Record<string, unknown>
}

function getRequired(schema: Schema | undefined): string[] {
  if (!schema || typeof schema !== 'object') return []
  const req = (schema as { required?: unknown }).required
  return Array.isArray(req) ? req.filter((r): r is string => typeof r === 'string') : []
}
```

- [ ] **Step 2: 在 NodeInspector 的 capability 分支嵌入 CapabilityParamsForm**

在 `NodeInspector.tsx` 顶部 import 新增：

```tsx
import { CapabilityParamsForm } from './CapabilityParamsForm'
```

把 capability 分支从：

```tsx
if (t === 'capability') return (
  <Form.Item name="capabilityKey" label="Capability" ...>
    <Select ... />
  </Form.Item>
)
```

改成：

```tsx
if (t === 'capability') {
  const selectedKey = getFieldValue('capabilityKey') as string | undefined
  const selected = capabilities.find(c => c.key === selectedKey)
  return (
    <>
      <Form.Item
        name="capabilityKey"
        label="Capability"
        rules={[{ required: true, message: '请选择 Capability' }]}
      >
        <Select
          showSearch
          placeholder="选择一个 Agent Capability"
          options={capabilityOptions(capabilities, selectedKey)}
          filterOption={(input, opt) => {
            const tx = (opt as { searchText?: string } | undefined)?.searchText ?? ''
            return tx.toLowerCase().includes(input.toLowerCase())
          }}
          onChange={(newKey) => {
            const newSchema = capabilities.find(c => c.key === newKey)?.paramSchema ?? {}
            const currentParams = (getFieldValue('capabilityParams') as Record<string, unknown> | undefined) ?? {}
            const filtered = filterParamsBySchema(currentParams, newSchema)
            form.setFieldsValue({ capabilityParams: filtered })
            onChange(node!.id, { capabilityKey: newKey, capabilityParams: filtered })
          }}
        />
      </Form.Item>
      {selected && (
        <Form.Item shouldUpdate noStyle>
          {() => (
            <CapabilityParamsForm
              paramSchema={selected.paramSchema}
              value={form.getFieldValue('capabilityParams') as Record<string, unknown> | undefined}
              onChange={(next) => {
                form.setFieldsValue({ capabilityParams: next })
                onChange(node!.id, { capabilityParams: next })
              }}
            />
          )}
        </Form.Item>
      )}
    </>
  )
}
```

并且把 `shouldUpdate` 那个外层 Form.Item 的 shouldUpdate 改为：`(p, c) => p.stageType !== c.stageType || p.capabilityKey !== c.capabilityKey`，确保切换 capabilityKey 时重新渲染动态表单。

- [ ] **Step 3: 补充 filterParamsBySchema 辅助函数**

在 `NodeInspector.tsx` 的 `capabilityOptions` 辅助之后追加：

```tsx
function filterParamsBySchema(
  params: Record<string, unknown>,
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const props = (schema as { properties?: unknown }).properties
  if (typeof props !== 'object' || props === null) return {}
  const keys = new Set(Object.keys(props as Record<string, unknown>))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(params)) {
    if (keys.has(k)) out[k] = v
  }
  return out
}
```

### Task 4.5: 前端必填校验与保存拦截

**Files:**
- Modify: `web/src/pipeline-canvas/panels/NodeInspector.tsx`
- Modify: `web/src/pipeline-canvas/PipelineCanvasPage.tsx`

- [ ] **Step 1: Inspector 内关键字段加 Form rules**

确认以下 Form.Item 都有 `required`:
- `name` —— 已有
- `capability` 分支的 `capabilityKey` —— Task 3.2 / 4.4 已加
- `wait_webhook` 分支的 `webhookTag` —— 替换为：

```tsx
if (t === 'wait_webhook') return (
  <Form.Item name="webhookTag" label="Webhook Tag" rules={[{ required: true, message: 'Webhook Tag 必填' }]}>
    <Input placeholder="例如 mr-merge:PAM/java-code/pas-6.0:123，支持 {{vars.xxx}} 模板" />
  </Form.Item>
)
```

- `im_input` 分支的 `imInputConfig.prompt` —— 已有 required，保留。

- [ ] **Step 2: PipelineCanvasPage 在 handleSave 前做全图校验**

在 `PipelineCanvasPage.tsx` 的 `handleSave` 之前增加辅助函数：

```tsx
function firstGraphIssue(nodes: ReadonlyArray<{ id: string; data: StageFields }>):
  | { nodeId: string; message: string }
  | null {
  for (const n of nodes) {
    const d = n.data
    if (!d.name?.trim()) return { nodeId: n.id, message: '节点缺少名称' }
    if (d.stageType === 'capability' && !d.capabilityKey?.trim()) {
      return { nodeId: n.id, message: `节点 ${d.name}: 未选择 Capability` }
    }
    if (d.stageType === 'wait_webhook' && !d.webhookTag?.trim()) {
      return { nodeId: n.id, message: `节点 ${d.name}: Webhook Tag 为空` }
    }
    if (d.stageType === 'im_input') {
      if (!d.imInputConfig?.prompt?.trim()) {
        return { nodeId: n.id, message: `节点 ${d.name}: 引导语为空` }
      }
      const ps = d.imInputConfig.paramSchema
      if (!ps || typeof ps !== 'object' || Array.isArray(ps)) {
        return { nodeId: n.id, message: `节点 ${d.name}: paramSchema 不是合法 object` }
      }
    }
    if (d.stageType === 'approval' && (!d.approverIds || d.approverIds.length === 0)) {
      return { nodeId: n.id, message: `节点 ${d.name}: 未选择审批人` }
    }
  }
  return null
}
```

把 `handleSave` 改为：

```tsx
async function handleSave() {
  const issue = firstGraphIssue(graph.nodes as { id: string; data: StageFields }[])
  if (issue) {
    message.error(issue.message)
    setSelectedId(issue.nodeId)
    return
  }
  try {
    await putPipelineGraph(pipelineId, graph.toWire())
    graph.resetDirty()
    message.success('已保存')
  } catch (e) {
    const err = e as { response?: { data?: { error?: string; details?: string[] } } }
    const details = err?.response?.data?.details
    if (details?.length) {
      message.error(`校验失败：${details.join('; ')}`)
    } else {
      message.error(err?.response?.data?.error ?? '保存失败')
    }
  }
}
```

- [ ] **Step 3: 构建通过**

```
cd web && pnpm build
```

Expected: PASS。

### Task 4.6: 变量引用提示 + 冒烟文档

**Files:**
- Modify: `web/src/pipeline-canvas/panels/NodeInspector.tsx`
- Create: `docs/smoke-canvas-inspector.md`

- [ ] **Step 1: 在 im_input.prompt 下方加变量提示**

im_input 分支的 `imInputConfig.prompt` Form.Item 替换为：

```tsx
<Form.Item
  name={['imInputConfig', 'prompt']}
  label="引导语"
  rules={[{ required: true, message: '引导语必填' }]}
  extra="支持 {{vars.xxx}} / {{triggerParams.xxx}} 模板"
>
  <Input.TextArea rows={3} placeholder="请提供以下参数：..." />
</Form.Item>
```

- [ ] **Step 2: 写冒烟文档**

创建 `docs/smoke-canvas-inspector.md`：

```markdown
# 冒烟测试：画布节点配置面板

场景覆盖 2026-04-22 设计（下拉化 + 数据流打通）的关键路径。

## 前置

- 后端：`pnpm dev`
- 前端：`cd web && pnpm dev`
- 访问 `/pipelines`，进入任一流水线的画布编辑页

## 场景 1：capability Select 基本流

1. 添加 `Agent Capability` 节点
2. 在 Inspector 点 "Capability" 下拉，应看到全量 capability 列表，每项显示 displayName + key + category tag
3. 在搜索框输入 capability 的 displayName 片段，可过滤
4. 选中一个有 paramSchema 的 capability，下方应自动出现"Capability 参数"字段组
5. 保存 → 重进画布 → 选中同一节点 → 依然能看到刚才的 capabilityKey 和参数

## 场景 2：capability 必填保存拦截

1. 添加 `Agent Capability` 节点（不选 capabilityKey）
2. 点击"保存" → 应弹 message.error 指向该节点名，节点 Inspector 自动打开
3. 网络面板应确认没有发出 PUT /test-pipelines/:id/graph 请求

## 场景 3：im_input → capability 数据流打通（E2E）

1. 添加 `IM 参数采集` 节点：
   - 引导语：`请提供 branch`
   - paramSchema：`{"type":"object","required":["branch"],"properties":{"branch":{"type":"string"}}}`
2. 添加 `Agent Capability` 节点（选一个需要 `ref` 参数的 capability），`capabilityParams.ref` 填 `{{vars.branch}}`
3. 连边 im_input → capability
4. 保存成功后，从 IM 触发该流水线 → 机器人发引导语 → 回复 `branch=main`
5. capability 节点应收到 `ref="main"`（可在日志或 capability 的 output 里确认）

## 场景 4：stageType 切换弹框

1. 添加脚本节点，填脚本内容 `echo hi`
2. 在 Inspector 把"类型"改成"Agent Capability"
3. 应弹确认框 `将清空：script`
4. 确认 → script 字段清空；取消 → 类型回退

## 场景 5：切换 capabilityKey 保留重叠字段

1. 选一个 capabilityA（schema 有 `foo`、`bar`），`foo=x`，`bar=y`
2. 切到 capabilityB（schema 只有 `foo`、`baz`）
3. 表单里 `foo=x` 保留，`bar` 被丢弃，`baz` 空

## 场景 6：stale capabilityKey 兼容

1. 手动在 DB 把 capability `deploy` 改 key 为 `deploy_renamed`
2. 重进画布 → capability 节点的 Select 显示 `deploy（不在能力列表中）`，带黄色 warning
3. 不触动即可保存；重选一个新 key 也可以

## 场景 7：im_input.capabilityKey 留空

1. 添加 im_input 节点，不选"关联 Capability"
2. 保存成功、触发执行无报错
```

### Task 4.7: Commit 4

- [ ] **Step 1: 提交**

```bash
git add web/src/pipeline-canvas/panels/ web/src/pipeline-canvas/PipelineCanvasPage.tsx docs/smoke-canvas-inspector.md
git commit -m "$(cat <<'EOF'
feat(pipeline-canvas): capabilityParams 动态表单 + stageType 切换 + 必填校验

- 按 capability.paramSchema 动态渲染参数表单（string/number/bool/enum）
  - 不支持类型 fallback 到 JSON TextArea
- 抽出 pruneStageFields / obsoleteFieldsOnSwitch 纯函数并附单测
- stageType 切换时，如有非空独占字段则弹 Modal.confirm
- targetRoles 只在 stageType=script 时显示
- handleSave 前全图遍历必填校验，失败聚焦到首个错误节点
- Webhook Tag / IM 引导语加模板用法 hint
- 冒烟测试清单

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review 检查清单（plan 写完后跑一遍）

1. ✅ **Spec 覆盖**
   - 2.数据加载、2.capabilityKey 下拉、2.stale 兼容：Task 3.1 / 3.2
   - 3.capabilityParams 动态表单：Task 4.4
   - 4.1 buildCapabilityNode 读 state：Task 1.3 Step 2
   - 4.2 StageHooks.runCapability 签名：Task 1.3 Step 1
   - 4.3 resolveCapabilityParams 扩展：Task 1.2
   - 4.4 约定文档：Task 1.5
   - 4.5 设计决策（runtimeVars 权衡）：不需要代码，spec 已记
   - 5.1 targetRoles 条件：Task 4.3
   - 5.2 stageType 切换：Task 4.1–4.2
   - 5.3 前端必填：Task 4.5
   - 5.4 后端 graph-validation：Task 2.1–2.2
   - 5.5 Variables 提示：Task 4.6 Step 1

2. ✅ **占位符扫描**：无 TBD / TODO / 省略。

3. ✅ **类型一致性**：`CapabilityOption` 在 Task 3.1 新增、3.2 + 4.4 引用；`pruneStageFields` / `obsoleteFieldsOnSwitch` 在 Task 4.1 定义，4.2 引用；`filterParamsBySchema` 在 Task 4.4 Step 3 定义，4.4 Step 2 引用。

## 执行风险与回退

- 后端改动若造成现有 fixture 失效：补 fixture，不放宽校验
- 前端 `tsc -b` 报错：多半是 Ant Design 类型收紧，确认 Select / Form 的泛型参数
- 冒烟 Scene 3（E2E）依赖 IM 真实通道，若测试环境未接入可跳过，单测 `im-capability-runtime-vars.test.ts` 已覆盖核心契约
