# QI Pipeline retryFromNode LangGraph State Mutation (Sub-plan E.2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 真正修通 `retryFromNode` + `retryFailedRun` 的 LangGraph 重启行为。Sub-plan E.1 smoke verify 发现：graph 已 routed to END（snapshot.next=[]）后，DB stage_results 截断 + InitialInput stream 无法让 LangGraph 重 run；checkpoint state 会把旧 stage_results merge 回 DB 覆盖截断。本 plan 用 `compiled.updateState(config, {}, asNode: predecessorStageName)` 把 LangGraph next 字段重定位到 fromNode 之前的预测节点，让 stream 真重跑 fromNode 及下游。

**Architecture:** 在 `graph-runner.ts` 加 `restartRunFromNode(runId, fromNodeId)` helper：
1. reload ctx + compile graph (复用 streamGraph 的 compile 路径，必要时把 compile 抽 helper)
2. 从 pipeline.graph.edges 找 fromNode 的预测（按 node.id 匹配 target → source）
3. 把 predecessor.id 转成 LangGraph stage name (`stage_<index>_<stageType>` 格式) — 通过 `nodeName(index, stage)` helper
4. 调 `compiled.updateState(config, {}, predecessorStageName)` 让 LangGraph 重算 next=[fromNode 的 LangGraph name]
5. 然后 `streamGraph(ctx, { runId })` 触发 stream from new next

`retryFromNode` 和 `retryFailedRun` 改用 `restartRunFromNode`。stage_results 不再需要 SQL 截断（reducer mergeStageResults 会按 name 用新结果覆盖旧 entry）。

**Tech Stack:** TypeScript ES2022 + LangGraph 0.2+ (updateState API) + PostgresSaver + Vitest + MemorySaver (集成测试)

**前置 Sub-plan E.1 + E:** 已落 origin/main 5 + 5 + 1 (E.2 fix) commits。Sub-plan E.1 §Risks #1 明确预测本问题。

**Out of Scope（本 plan 不涉及）：**
- 从 entry 节点（init_qi_branch，无预测）重启 — 需要完整 checkpoint 重置，复杂度另估
- 多预测节点的 conditional edge resolution（先取 first predecessor，文档化）
- `stepOutputs` 截断（旧的 stepOutputs 仍留在 LangGraph state，被新 run 覆盖；如果新 run 不 reach 某节点，旧数据残留）

---

## File Structure

**Create:**
- `src/__tests__/integration/qi-retry-restart-positioning.test.ts` — 集成测试用 MemorySaver 验证 updateState + stream 真重 run

**Modify:**
- `src/pipeline/graph-builder.ts` — export `nodeName` helper（当前 module-local）
- `src/pipeline/graph-runner.ts` — 加 `restartRunFromNode(runId, fromNodeId)` + 重构 streamGraph compile 部分抽 `compileGraph(ctx)` helper（让 restartRunFromNode 复用）
- `src/pipeline/graph-runner.ts:retryFromNode` — 删 SQL 截断（reducer 覆盖即可）+ 改调 restartRunFromNode
- `src/pipeline/graph-runner.ts:retryFailedRun` — 改调 restartRunFromNode（fromNodeId = 最后失败 stage 的 name）

**单元测试 pattern 参考：** `src/__tests__/unit/graph-runtime.test.ts`（MemorySaver 模式）+ `src/__tests__/integration/qi-retry-from-node.test.ts`

---

## Task 1: 导出 `nodeName` helper + 加 `findPredecessorStageName` helper

`nodeName(index, stage)` 当前是 `graph-builder.ts` module-local，返回 `stage_<index>_<stageType>` 格式（LangGraph addNode 用的标识）。Sub-plan E.2 需要从外部调用，导出它。

加 `findPredecessorStageName(pipeline, fromNodeId)` helper：从 edges 找 fromNode 的第一个预测，返回该预测的 LangGraph stage name。

**Files:**
- Modify: `src/pipeline/graph-builder.ts` — `nodeName` 加 export
- Create new helper `findPredecessorStageName(pipeline, fromNodeId): string | null`

### Steps

- [ ] **Step 1.1: 探查 nodeName + edges 结构**

```bash
grep -n "function nodeName\|builder.addNode(name\|export.*function" src/pipeline/graph-builder.ts | head -10
```

确认：
- `nodeName(index, stage)` 返回 `stage_<index>_<stageType>`
- `builder.addNode(name, ...)` 用此 name
- 把 `nodeName` 改为 `export function nodeName(...)`

- [ ] **Step 1.2: 加 export nodeName**

```typescript
// src/pipeline/graph-builder.ts
export function nodeName(index: number, stage: StageDefinition): string {
  return `stage_${index}_${stage.stageType}`
}
```

- [ ] **Step 1.3: 加 findPredecessorStageName helper**

在 `graph-builder.ts` 同文件加（紧跟 nodeName 之后）：

```typescript
/**
 * Find the first predecessor of `fromNodeId` in pipeline.graph.edges,
 * and return its LangGraph stage name (`stage_<index>_<stageType>`).
 *
 * Used by retry-from-node: setting `asNode=<predecessor stage name>` in
 * `compiled.updateState(...)` makes LangGraph treat predecessor as "just done",
 * which re-computes `snapshot.next=[fromNode]` so subsequent stream re-runs fromNode.
 *
 * Returns null if fromNode is an entry node (no predecessor). Caller must
 * handle this case separately (entry node retry not supported in v1).
 *
 * For multi-predecessor DAGs, picks first predecessor by edge order.
 * If edge has a `condition`, LangGraph re-evaluates conditional routing
 * during stream — picking any valid predecessor should still route to fromNode.
 */
export function findPredecessorStageName(
  pipeline: PipelineGraph,
  fromNodeId: string,
): string | null {
  const predecessorEdge = pipeline.edges.find((e) => e.target === fromNodeId)
  if (!predecessorEdge) return null
  const predecessorIndex = pipeline.nodes.findIndex((n) => n.id === predecessorEdge.source)
  if (predecessorIndex < 0) return null
  return nodeName(predecessorIndex, pipeline.nodes[predecessorIndex])
}
```

注意：`PipelineGraph` 类型 import from `'./types.js'`。如果该 import 还没有，加上。

- [ ] **Step 1.4: 单测**

Create `src/__tests__/unit/pipeline/graph-builder-predecessor.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { findPredecessorStageName, nodeName } from '../../../pipeline/graph-builder.js'
import type { PipelineGraph } from '../../../pipeline/types.js'

describe('findPredecessorStageName', () => {
  const graph: PipelineGraph = {
    nodes: [
      { id: 'init_branch', name: 'Init Branch', stageType: 'init_qi_branch' } as any,
      { id: 'spec_author', name: 'Spec Author', stageType: 'llm_author' } as any,
      { id: 'spec_ai_review', name: 'Spec AI Review', stageType: 'llm_review' } as any,
    ],
    edges: [
      { id: 'e1', source: 'init_branch', target: 'spec_author' },
      { id: 'e2', source: 'spec_author', target: 'spec_ai_review' },
    ],
  }

  it('returns predecessor LangGraph stage name for middle node', () => {
    expect(findPredecessorStageName(graph, 'spec_ai_review')).toBe('stage_1_llm_author')
  })

  it('returns null for entry node (no predecessor)', () => {
    expect(findPredecessorStageName(graph, 'init_branch')).toBeNull()
  })

  it('returns null for unknown node id', () => {
    expect(findPredecessorStageName(graph, 'nonexistent')).toBeNull()
  })

  it('picks first predecessor when multiple', () => {
    const dagGraph: PipelineGraph = {
      nodes: [
        { id: 'a', name: 'A', stageType: 'script' } as any,
        { id: 'b', name: 'B', stageType: 'script' } as any,
        { id: 'c', name: 'C', stageType: 'script' } as any,
      ],
      edges: [
        { id: 'e1', source: 'a', target: 'c' },
        { id: 'e2', source: 'b', target: 'c' },
      ],
    }
    // 'a' is first in edges → first predecessor of 'c'
    expect(findPredecessorStageName(dagGraph, 'c')).toBe('stage_0_script')
  })
})

describe('nodeName', () => {
  it('formats as stage_<index>_<stageType>', () => {
    expect(nodeName(0, { stageType: 'init_qi_branch' } as any)).toBe('stage_0_init_qi_branch')
    expect(nodeName(5, { stageType: 'llm_review' } as any)).toBe('stage_5_llm_review')
  })
})
```

- [ ] **Step 1.5: Run + Commit**

```bash
npx vitest run src/__tests__/unit/pipeline/graph-builder-predecessor.test.ts
./test.sh --typecheck
```

```bash
git add src/pipeline/graph-builder.ts src/__tests__/unit/pipeline/graph-builder-predecessor.test.ts
git commit -m "feat(qi/graph): export nodeName + 加 findPredecessorStageName helper

为 Sub-plan E.2 retryFromNode LangGraph 状态重定位做准备。
- nodeName(index, stage) 改为 export（LangGraph stage 标识符 'stage_<i>_<type>'）
- 新增 findPredecessorStageName(pipeline, fromNodeId)：按 edges 找第一个预测，
  返回其 LangGraph stage name。Entry 节点（无预测）返 null。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: `graph-runner.ts` 加 `restartRunFromNode(runId, fromNodeId)`

新 helper：reload ctx + compile graph + updateState({}, predecessor) + streamGraph。让 LangGraph 真正重 run from fromNode。

**Files:**
- Modify: `src/pipeline/graph-runner.ts`
  - Refactor: streamGraph 的 compile 部分抽 helper `compileGraph(ctx, saver)`（让 restartRunFromNode 也能 compile）
  - Add: `restartRunFromNode(runId, fromNodeId)`

### Steps

- [ ] **Step 2.1: 探查 streamGraph compile 部分**

```bash
grep -n "graphBuilder\|getCheckpointer\|.compile(" src/pipeline/graph-runner.ts | head -15
```

看 streamGraph 内 compile graph 那块代码（buildGraphFromPipeline / buildGraphFromStages + .compile）。

- [ ] **Step 2.2: 重构 — 抽 compileGraph helper**

```typescript
// src/pipeline/graph-runner.ts
import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres'
import { buildGraphFromPipeline, buildGraphFromStages } from './graph-builder.js'

/**
 * Compile the pipeline graph for a given run context.
 * Used by streamGraph and restartRunFromNode.
 */
function compileGraph(ctx: RunContext, saver: PostgresSaver) {
  const graphBuilder = ctx.pipelineGraph
    ? buildGraphFromPipeline({
        graph: ctx.pipelineGraph,
        stageContext: ctx.stageContext,
        hooks: ctx.hooks,
        triggerParams: ctx.triggerParams,
      })
    : buildGraphFromStages({
        stages: ctx.stages,
        stageContext: ctx.stageContext,
        hooks: ctx.hooks,
        triggerParams: ctx.triggerParams,
      })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (graphBuilder as any).compile({ checkpointer: saver })
}
```

修改 `streamGraph` 内部用这个 helper（删除原 compile 代码块）。verify typecheck + 现有测试不挂。

- [ ] **Step 2.3: 加 restartRunFromNode**

```typescript
// src/pipeline/graph-runner.ts
import { findPredecessorStageName } from './graph-builder.js'

/**
 * Restart pipeline run from a specific node (LangGraph state-mutating retry).
 *
 * Used by retryFromNode / retryFailedRun. Implements Sub-plan E.2 fix:
 * Sub-plan E.1 smoke verify 发现 streamGraph(InitialInput) on a "done" graph 直接退出。
 * 本 helper 调用 compiled.updateState(config, {}, asNode: predecessor) 让 LangGraph 重算
 * `snapshot.next=[fromNode]` 再 stream，强制重 run。
 *
 * mergeStageResults reducer 按 name 合并，所以新 run 产生的 entry 会覆盖旧的
 * （same name → shallow merge new wins）。无需手动截断 stage_results。
 *
 * Throws if:
 * - run not found
 * - pipeline.graph not loaded
 * - fromNodeId is entry node (no predecessor — v1 not supported)
 * - LangGraph updateState fails
 */
export async function restartRunFromNode(
  runId: number,
  fromNodeId: string,
): Promise<void> {
  const ctx = await reloadContext(runId)
  if (!ctx) {
    console.warn(`[graph-runner] restartRunFromNode: run ${runId} not resumable`)
    return
  }
  if (!ctx.pipelineGraph) {
    throw new Error(
      `restartRunFromNode: run ${runId} has no pipelineGraph (legacy stages mode not supported)`,
    )
  }

  const predecessorStageName = findPredecessorStageName(ctx.pipelineGraph, fromNodeId)
  if (!predecessorStageName) {
    throw new Error(
      `restartRunFromNode: fromNodeId '${fromNodeId}' has no predecessor in pipeline graph (entry-node retry not supported in v1)`,
    )
  }

  const saver = await getCheckpointer()
  const compiled = compileGraph(ctx, saver)
  const config = { configurable: { thread_id: String(runId) } }

  // updateState with empty values + asNode=predecessor → LangGraph re-computes next=[fromNode-langgraph-name]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (compiled as any).updateState(config, {}, predecessorStageName)

  // Stream picks up at fromNode (the new next)
  await streamGraph(ctx, { runId: ctx.runId })
}
```

- [ ] **Step 2.4: 修 retryFromNode 用 restartRunFromNode**

修改 `retryFromNode`：

1. 删除 SQL truncate stage_results 块（reducer 会自动 overwrite）
2. 删除 `restartRunFromCheckpoint(runId)` 调用
3. 改为 `restartRunFromNode(runId, matchingNode.id)` —— 用 node.id 而非 display name（findPredecessorStageName 期望 node.id）

```typescript
export async function retryFromNode(
  runId: number,
  fromNodeId: string,
): Promise<void> {
  const run = await getTestRunById(runId)
  if (!run) throw new Error(`retryFromNode: run ${runId} not found`)
  if (run.status !== 'failed') {
    throw new Error(
      `retryFromNode: run ${runId} status is '${run.status}', expected 'failed'`,
    )
  }

  const pipeline = await getTestPipelineById(run.pipelineId)
  if (!pipeline) throw new Error(`retryFromNode: pipeline ${run.pipelineId} not found`)
  const nodes = (pipeline.graph as any)?.nodes ?? []
  const matchingNode = nodes.find(
    (n: any) => n.id === fromNodeId || n.name === fromNodeId,
  )
  if (!matchingNode) {
    throw new Error(
      `retryFromNode: fromNodeId '${fromNodeId}' not found in pipeline graph (by id or name)`,
    )
  }

  // cap check + increment（用 matchingNode.id 作 stable key）
  const req = await getRequirementByPipelineRunId(runId)
  if (req) {
    const count = await getNodeRetryCount(req.id, matchingNode.id)
    if (count >= NODE_RETRY_CAP) {
      throw new Error(
        `retryFromNode: node '${fromNodeId}' has been retried ${count} times (cap=${NODE_RETRY_CAP})`,
      )
    }
    await incrementNodeRetryCount(req.id, matchingNode.id)
  }

  await updateTestRunStatus(runId, 'running')
  // Sub-plan E.2: LangGraph state mutation + restart
  await restartRunFromNode(runId, matchingNode.id)
}
```

注意：不再调 SQL truncate。stage_results 自然由 reducer 覆盖（旧的 failed entry 被 fromNode 新 success entry overwrites by name）。

- [ ] **Step 2.5: 修 retryFailedRun 用 restartRunFromNode**

retryFailedRun 自动选最后失败的 stage。但 stage_results.name 是 display name，要先映射回 node.id。

```typescript
export async function retryFailedRun(runId: number): Promise<void> {
  const run = await getTestRunById(runId)
  if (!run) throw new Error(`retryFailedRun: run ${runId} not found`)
  if (run.status !== 'failed') {
    throw new Error(
      `retryFailedRun: run ${runId} status is '${run.status}', expected 'failed'`,
    )
  }

  const stageResults = run.stageResults ?? []
  const lastFailed = [...stageResults].reverse().find((s) => s.status === 'failed')
  if (!lastFailed) {
    throw new Error(
      `retryFailedRun: run ${runId} has no failed stage to retry from`,
    )
  }

  // 映射 stage_results.name (display name) → node.id
  const pipeline = await getTestPipelineById(run.pipelineId)
  if (!pipeline) throw new Error(`retryFailedRun: pipeline ${run.pipelineId} not found`)
  const nodes = (pipeline.graph as any)?.nodes ?? []
  const failedNode = nodes.find(
    (n: any) => n.id === lastFailed.name || n.name === lastFailed.name,
  )
  if (!failedNode) {
    throw new Error(
      `retryFailedRun: failed stage name '${lastFailed.name}' not found in pipeline graph`,
    )
  }

  // cap check + increment
  const req = await getRequirementByPipelineRunId(runId)
  if (req) {
    const count = await getNodeRetryCount(req.id, failedNode.id)
    if (count >= NODE_RETRY_CAP) {
      throw new Error(
        `retryFailedRun: node '${failedNode.id}' has been retried ${count} times (cap=${NODE_RETRY_CAP})`,
      )
    }
    await incrementNodeRetryCount(req.id, failedNode.id)
  }

  await updateTestRunStatus(runId, 'running')
  await restartRunFromNode(runId, failedNode.id)
}
```

- [ ] **Step 2.6: 删过时的 restartRunFromCheckpoint 函数**

`restartRunFromCheckpoint`（commit `05d78b4` 加的）只在 retryFailedRun + retryFromNode 用，现在两处都改了，可以删了。如果其他地方有用，留着。grep 确认：

```bash
grep -n "restartRunFromCheckpoint" src/
```

如果没人用，删除该 export。

- [ ] **Step 2.7: 跑现有 qi-retry-admin + qi-retry-from-node 测试**

```bash
./test.sh --typecheck
npx vitest run --exclude '**/var/**' src/__tests__/integration/qi-retry-admin src/__tests__/integration/qi-retry-from-node
```

预期：现有测试可能 fail（因为 retryFromNode 不再 truncate stage_results）。修测试 assertion：
- 之前 "truncates stage_results back to fromNode" 测试：现在 retryFromNode 不 truncate，stage_results 保持原长度（mergeStageResults 不在测试场景跑因为 reloadContext 返 null）。改 assertion：不验证 stage_results 截断；改 verify 调用 restartRunFromNode（mock 它）

具体修改：测试里把 stage_results 截断 assert 改为「调用 restartRunFromNode 1 次 with 正确参数」。可能需要重新 mock 策略。

如改测试有难度，BLOCKED escalate。

- [ ] **Step 2.8: Commit**

```bash
git add src/pipeline/graph-runner.ts
# 测试改动跟代码一起 commit
git add src/__tests__/integration/qi-retry-admin.test.ts src/__tests__/integration/qi-retry-from-node.test.ts
git commit -m "fix(qi): retryFromNode/retryFailedRun 真重 run fromNode (LangGraph state mutation)

Sub-plan E.1 smoke 发现 graph 已 routed END 后 stream 无法重 run。修复：
- 加 restartRunFromNode(runId, fromNodeId) 助手：compile graph + updateState({}, asNode=predecessor) + stream
- updateState 让 LangGraph 重算 next=[fromNode-langgraph-name]，stream 真重跑 fromNode 及下游
- mergeStageResults reducer 按 name 覆盖，无需手动截断 stage_results
- retryFromNode + retryFailedRun 都改用 restartRunFromNode
- 限制：entry 节点 retry (无 predecessor) 不支持（v1，留 follow-up）
- 限制：多 predecessor 取第一个（conditional edges 由 LangGraph re-evaluate 兜底）

测试改动：删 'stage_results 截断' assertion (reducer 自动 overwrite)；
verify restartRunFromNode 被调用 with 正确参数。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: 集成测试 — MemorySaver verify 真 LangGraph 重启

之前 Sub-plan E + E.1 测试都 mock 让 reloadContext 早 return，没真验证 LangGraph 行为。Sub-plan E.2 加一个 **真 MemorySaver** 集成测试，build 真 LangGraph + invoke + verify updateState + stream 真重 run。

**Files:**
- Create: `src/__tests__/integration/qi-retry-restart-positioning.test.ts`

### Steps

- [ ] **Step 3.1: 探查 MemorySaver 用法**

```bash
grep -n "MemorySaver\|@langchain/langgraph" src/__tests__/unit/graph-runtime.test.ts | head -10
```

看现有 MemorySaver 集成测试 pattern。

- [ ] **Step 3.2: 写 MemorySaver 集成测试**

Create `src/__tests__/integration/qi-retry-restart-positioning.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { MemorySaver, StateGraph } from '@langchain/langgraph'
import { PipelineStateAnnotation } from '../../pipeline/graph-state.js'

describe('LangGraph updateState + asNode positioning (Sub-plan E.2 验证)', () => {
  it('updateState(asNode=B) lets stream resume at C (B->C edge), re-running C', async () => {
    let cCallCount = 0
    let bCallCount = 0

    const graph = new StateGraph(PipelineStateAnnotation)
      .addNode('stage_0_a', async () => ({
        currentStageIndex: 0,
        stageResults: [{ name: 'A', type: 'a', status: 'success' as const }],
      }))
      .addNode('stage_1_b', async () => {
        bCallCount++
        return {
          currentStageIndex: 1,
          stageResults: [{ name: 'B', type: 'b', status: 'success' as const }],
        }
      })
      .addNode('stage_2_c', async () => {
        cCallCount++
        return {
          currentStageIndex: 2,
          stageResults: [{ name: 'C', type: 'c', status: 'success' as const }],
        }
      })
      .addEdge('__start__', 'stage_0_a')
      .addEdge('stage_0_a', 'stage_1_b')
      .addEdge('stage_1_b', 'stage_2_c')

    const compiled = graph.compile({ checkpointer: new MemorySaver() })
    const config = { configurable: { thread_id: 'test-1' } }

    // Initial run — all 3 nodes execute
    const result1 = await compiled.invoke({ runId: 1 }, config)
    expect(bCallCount).toBe(1)
    expect(cCallCount).toBe(1)
    expect(result1.stageResults.map((s: any) => s.name)).toEqual(['A', 'B', 'C'])

    // Snapshot should be at END (next=[])
    const snap1 = await compiled.getState(config)
    expect(snap1.next).toEqual([])

    // Now reposition: tell LangGraph "B just done, next is C"
    await compiled.updateState(config, {}, 'stage_1_b')

    // Snapshot should now point to C
    const snap2 = await compiled.getState(config)
    expect(snap2.next).toEqual(['stage_2_c'])

    // Stream — should only run C again
    await compiled.invoke(null, config)
    expect(bCallCount).toBe(1)  // B 没有再跑
    expect(cCallCount).toBe(2)  // C 跑了第二次！
  })
})
```

- [ ] **Step 3.3: Run — expect PASS（验证 LangGraph 真支持 updateState repositioning）**

```bash
npx vitest run src/__tests__/integration/qi-retry-restart-positioning.test.ts
```

⚠️ **如果此测试 FAIL**：意味着 LangGraph 行为跟假设不一致。需要 BLOCKED escalate，重新设计 retryFromNode 策略（可能要用 Command(goto)，可能要清 checkpoint 重新 invoke，可能完全 LangGraph 不支持）。

- [ ] **Step 3.4: Commit**

```bash
git add src/__tests__/integration/qi-retry-restart-positioning.test.ts
git commit -m "test(qi): MemorySaver 集成测试验证 LangGraph updateState + asNode 真重 run

Sub-plan E.2 核心假设：compiled.updateState(config, {}, asNode=predecessor) 让
LangGraph 重算 snapshot.next=[next_node_after_predecessor]，stream 真重 run。
这个测试用真 MemorySaver + 3 节点 toy graph 验证此行为。

如果此测试 FAIL（LangGraph 不支持 repositioning），Sub-plan E.2 设计需要重新评估。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: 手动 smoke verify

Sub-plan E.2 实现完成后，验证真实 QI pipeline 上的行为。

### Steps

- [ ] **Step 4.1: 启 server**

```bash
pnpm dev 2>&1 | tee logs/smoke-e2-server.log &
sleep 8
curl -s -X POST 'http://127.0.0.1:3000/admin/auth/login' \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"Paraview2026"}' \
  -c /tmp/qi-cookies.txt
```

- [ ] **Step 4.2: 找 failed requirement（或建新）**

```bash
psql postgres://zhangshanshan@localhost:5432/chatops -c \
  "SELECT id, status, pipeline_run_id FROM requirements WHERE status='failed' LIMIT 5"
```

应有 #2 或 #3。

- [ ] **Step 4.3: 调 retry-from-node API**

```bash
# 用 req #2 (Spec AI Review failed) 测试 — role 文件已补，重 run 应该 success
curl -s -X POST 'http://127.0.0.1:3000/admin/requirements/2/retry-from-node' \
  -H 'Content-Type: application/json' \
  -b /tmp/qi-cookies.txt \
  -d '{"fromNodeId":"spec_ai_review"}'
```

预期：
- HTTP 200 `{"ok":true, "retriedFromNode":"spec_ai_review"}`
- 后台 LangGraph 重 run spec_ai_review

- [ ] **Step 4.4: Verify 真重 run（关键 assertion）**

```bash
sleep 60  # 给 LLM 调用时间

# 看 spec_ai_review entry 是否 timestamp 更新
psql postgres://zhangshanshan@localhost:5432/chatops -tAc \
  "SELECT jsonb_pretty(stage_results->2) FROM test_runs WHERE id=2"
```

预期 `startedAt` 是**新时间戳**（Sub-plan E.2 实现完成后的时间），不是原 11AM。如果是新时间戳 → ✅ 真重 run 了！

- [ ] **Step 4.5: 看下游节点行为**

```bash
psql postgres://zhangshanshan@localhost:5432/chatops -tAc \
  "SELECT jsonb_path_query_array(stage_results, '\$[*].\"status\"') FROM test_runs WHERE id=2"
```

下游节点（spec_human_gate / spec_commit_push / plan_author / ...）应该都新跑了一遍。

- [ ] **Step 4.6: 记录结果**

如真 ✅：sub-plan E.2 成功。
如仍❌：BLOCKED escalate — LangGraph 行为可能跟假设不符，重新设计。

- [ ] **Step 4.7: 杀 server + cleanup**

```bash
pkill -f "pnpm dev|tsx watch"
```

- [ ] **Step 4.8: 不 commit**（仅 verify；如有 fix 在 Task 2 内补）

---

## Self-Review

- [ ] **Spec coverage**：spec §5.5 'invalidate_downstream' 模式真正实现 ✅。Sub-plan E.1 §Risks #1 明确预测的问题在本 plan 修复 ✅。

- [ ] **Placeholder scan**：无 TODO/TBD。Entry 节点 retry / 多 predecessor 处理已明确为 v1 限制 + follow-up，不算 placeholder。

- [ ] **Type consistency**：
  - `restartRunFromNode(runId: number, fromNodeId: string)` signature 一致 ✅
  - `findPredecessorStageName(pipeline: PipelineGraph, fromNodeId: string): string | null` ✅
  - retryFromNode 和 retryFailedRun 都用 `node.id` 作为 fromNodeId 传给 restartRunFromNode（注意区分 node.id vs display name）✅

- [ ] **风险**：
  - Task 3 的 MemorySaver 测试**必须**先 pass，否则整个 Sub-plan E.2 设计 invalid
  - Entry 节点 retry 报 explicit error（不支持）— UX trade-off，文档化
  - 多 predecessor 取 first — DAG 路径可能不准。但 mergeStageResults 会覆盖，最坏情况是某些 stage_results 残留旧数据。可接受

---

## 已知 follow-up（不阻塞）

1. **Entry 节点 retry**：fromNode 是 init_qi_branch 时无预测。需要清 checkpoint thread 重新 invoke。复杂度中。
2. **多 predecessor**：用户主动从节点 X retry，X 有 2+ 个 predecessor。当前选 first，可能错过 conditional edge 上的特定路径。需要 UI 给用户选 predecessor，或 inspect 当前 stage_results 决定哪个 predecessor 最近 success。复杂度中。
3. **stepOutputs 截断**：retryFromNode 不动 stepOutputs。downstream 节点用 `state.stepOutputs[...]` 读上游可能拿到 stale 数据。新 run 会自然覆盖（节点重 run），但中间 race 可能不一致。低优先级，验证后再议。
4. **stage_results 「过期」标记**：旧 stage_results entry 没显式 "stale" 标记，UI 可能展示混乱。可以在 retryFromNode 时给下游 entry 加 meta.stale=true。低优先级。

---

## Execution Handoff

Plan 写完，保存到 `docs/superpowers/plans/2026-05-11-qi-pipeline-retry-langgraph-state-sub-plan-e2.md`。

**风险：**
- Task 3 的 MemorySaver assumption test 是 Sub-plan E.2 设计的核心 prerequisite。如果 fail，整个方案需要重新评估
- Task 2 涉及 graph-runner 重构 + retry 全部重写 — 改动面积较大，但对外契约（API endpoint）不变

**执行选项：**

1. **Subagent-Driven（推荐）** — 每 task fresh subagent + 两阶段 review，Task 3 即使 fail 也能 isolate
2. **Inline 执行** — 当前 session 用 executing-plans skill 批量跑

Which approach?
