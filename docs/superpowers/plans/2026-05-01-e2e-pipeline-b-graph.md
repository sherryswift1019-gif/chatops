# E2E Pipeline B — 图组装 + Governor 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 组装 Pipeline B LangGraph 图（条件边 + 自循环）、实现 governor 预算检查、提供 runPipelineB() 入口函数和错误 teardown 保障。

**Architecture:** LangGraph StateGraph 通过条件边实现 main_switch 自循环；governor 作为纯函数在 mainSwitchRoute 里调用；runner.ts 是外部调用点，负责排队限制 + try/catch teardown 兜底。

**Tech Stack:** TypeScript, @langchain/langgraph, Vitest

**前置条件:** Plan B1（e2e-fix agent）、Plan B2（evidence 收集）、Plan B3+B4（所有节点）全部完成

---

## 文件地图

| 操作 | 路径 |
|---|---|
| 新建 | `src/e2e/pipeline-b/governor.ts` |
| 新建 | `src/e2e/pipeline-b/graph.ts` |
| 新建 | `src/e2e/pipeline-b/runner.ts` |
| 新建 | `src/__tests__/unit/governor.test.ts` |
| 新建 | `src/__tests__/integration/pipeline-b-graph.test.ts` |

---

### Task 1: Governor 单测 + 实现

**Files:**
- 新建: `src/e2e/pipeline-b/governor.ts`
- 新建: `src/__tests__/unit/governor.test.ts`

- [ ] **Step 1: 先写单测（red phase）**

```typescript
// src/__tests__/unit/governor.test.ts
import { describe, it, expect } from 'vitest'
import { governorCheck, isScenarioOverBudget } from '../../e2e/pipeline-b/governor.js'
import type { GovernorState } from '../../e2e/pipeline-b/types.js'

function makeGovernorState(overrides: Partial<GovernorState> = {}): GovernorState {
  return {
    runStartedAt: Date.now() - 1000,
    totalAttempts: 0,
    perScenarioAttempts: {},
    limits: {
      maxPerScenarioAttempts: 3,
      maxRunHours: 4,
      maxTotalAttempts: 30,
    },
    ...overrides,
  }
}

describe('governorCheck', () => {
  it('新建 run 返回 continue', () => {
    const state = makeGovernorState()
    expect(governorCheck(state)).toBe('continue')
  })

  it('totalAttempts 刚好等于上限返回 over_budget', () => {
    const state = makeGovernorState({ totalAttempts: 30 })
    expect(governorCheck(state)).toBe('over_budget')
  })

  it('totalAttempts 超过上限返回 over_budget', () => {
    const state = makeGovernorState({ totalAttempts: 31 })
    expect(governorCheck(state)).toBe('over_budget')
  })

  it('totalAttempts 低于上限返回 continue', () => {
    const state = makeGovernorState({ totalAttempts: 29 })
    expect(governorCheck(state)).toBe('continue')
  })

  it('run 超过 maxRunHours 返回 over_budget', () => {
    const fourHoursMs = 4 * 3600 * 1000
    const state = makeGovernorState({ runStartedAt: Date.now() - fourHoursMs - 1 })
    expect(governorCheck(state)).toBe('over_budget')
  })

  it('run 未超 maxRunHours 返回 continue', () => {
    const twoHoursMs = 2 * 3600 * 1000
    const state = makeGovernorState({ runStartedAt: Date.now() - twoHoursMs })
    expect(governorCheck(state)).toBe('continue')
  })

  it('自定义 maxTotalAttempts 覆盖默认值', () => {
    const state = makeGovernorState({
      totalAttempts: 10,
      limits: { maxPerScenarioAttempts: 3, maxRunHours: 4, maxTotalAttempts: 10 },
    })
    expect(governorCheck(state)).toBe('over_budget')
  })
})

describe('isScenarioOverBudget', () => {
  it('scenario 无记录返回 false', () => {
    const state = makeGovernorState()
    expect(isScenarioOverBudget('login-success', state)).toBe(false)
  })

  it('scenario attempts 低于上限返回 false', () => {
    const state = makeGovernorState({ perScenarioAttempts: { 'login-success': 2 } })
    expect(isScenarioOverBudget('login-success', state)).toBe(false)
  })

  it('scenario attempts 等于上限返回 true', () => {
    const state = makeGovernorState({ perScenarioAttempts: { 'login-success': 3 } })
    expect(isScenarioOverBudget('login-success', state)).toBe(true)
  })

  it('scenario attempts 超过上限返回 true', () => {
    const state = makeGovernorState({ perScenarioAttempts: { 'login-success': 5 } })
    expect(isScenarioOverBudget('login-success', state)).toBe(true)
  })

  it('自定义 maxPerScenarioAttempts 生效', () => {
    const state = makeGovernorState({
      perScenarioAttempts: { 'create-prd': 5 },
      limits: { maxPerScenarioAttempts: 5, maxRunHours: 4, maxTotalAttempts: 30 },
    })
    expect(isScenarioOverBudget('create-prd', state)).toBe(true)
  })
})
```

- [ ] **Step 2: 实现 governor.ts**

```typescript
// src/e2e/pipeline-b/governor.ts
import type { GovernorState } from './types.js'

export type GovernorDecision = 'continue' | 'over_budget'

export function governorCheck(state: GovernorState): GovernorDecision {
  if (Date.now() - state.runStartedAt > state.limits.maxRunHours * 3600 * 1000) {
    return 'over_budget'
  }
  if (state.totalAttempts >= state.limits.maxTotalAttempts) {
    return 'over_budget'
  }
  return 'continue'
}

export function isScenarioOverBudget(scenarioId: string, state: GovernorState): boolean {
  return (state.perScenarioAttempts[scenarioId] ?? 0) >= state.limits.maxPerScenarioAttempts
}
```

- [ ] **Step 3: 跑单测确认绿**

```bash
npx vitest run src/__tests__/unit/governor.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/e2e/pipeline-b/governor.ts src/__tests__/unit/governor.test.ts
git commit -m "feat(e2e): Pipeline B governor 预算检查（纯函数 + 单测）"
```

---

### Task 2: 图结构定义（graph.ts）

**Files:**
- 新建: `src/e2e/pipeline-b/graph.ts`

- [ ] **Step 1: 实现图组装**

```typescript
// src/e2e/pipeline-b/graph.ts
import { StateGraph, END } from '@langchain/langgraph'
import { PipelineBState, type PipelineBStateType } from './types.js'
import { governorCheck } from './governor.js'
import { initRunNode } from './nodes/init-run.js'
import { setupSandboxNode } from './nodes/setup-sandbox.js'
import { deployInitialNode } from './nodes/deploy-initial.js'
import { discoverNode } from './nodes/discover.js'
import { pickNextScenarioNode } from './nodes/pick-next-scenario.js'
import { runScenarioNode } from './nodes/run-scenario.js'
import { collectEvidenceNode } from './nodes/collect-evidence.js'
import { resetIterationBranchNode } from './nodes/reset-iteration-branch.js'
import { e2eFixAgentNode } from './nodes/e2e-fix-agent.js'
import { redeployNode } from './nodes/redeploy.js'
import { healthcheckNode } from './nodes/healthcheck.js'
import { markGreenNode } from './nodes/mark-green.js'
import { markUnfixableNode } from './nodes/mark-unfixable.js'
import { createSummaryMrNode } from './nodes/create-summary-mr.js'
import { finalizeFailed } from './nodes/finalize-failed.js'
import { teardownSandboxNode } from './nodes/teardown-sandbox.js'

function mainSwitchRoute(state: PipelineBStateType): string {
  if (state.pendingScenarios.length === 0) return 'all_passed'
  if (governorCheck(state.governorState) === 'over_budget') return 'over_budget'
  return 'continue'
}

function scenarioResultRoute(state: PipelineBStateType): string {
  return state.lastScenarioResult === 'pass' ? 'pass' : 'fail'
}

function fixResultRoute(state: PipelineBStateType): string {
  return state.lastFixResult?.success === true ? 'success' : 'failure'
}

export function buildPipelineBGraph() {
  const graph = new StateGraph(PipelineBState)

  graph.addNode('init_run', initRunNode)
  graph.addNode('setup_sandbox', setupSandboxNode)
  graph.addNode('deploy_initial', deployInitialNode)
  graph.addNode('discover', discoverNode)
  graph.addNode('main_switch', async (state: PipelineBStateType) => state)
  graph.addNode('pick_next_scenario', pickNextScenarioNode)
  graph.addNode('run_scenario', runScenarioNode)
  graph.addNode('collect_evidence', collectEvidenceNode)
  graph.addNode('reset_iteration_branch', resetIterationBranchNode)
  graph.addNode('e2e_fix_agent', e2eFixAgentNode)
  graph.addNode('redeploy', redeployNode)
  graph.addNode('healthcheck', healthcheckNode)
  graph.addNode('mark_green', markGreenNode)
  graph.addNode('mark_unfixable', markUnfixableNode)
  graph.addNode('create_summary_mr', createSummaryMrNode)
  graph.addNode('finalize_failed', finalizeFailed)
  graph.addNode('teardown_sandbox', teardownSandboxNode)

  graph.setEntryPoint('init_run')
  graph.addEdge('init_run', 'setup_sandbox')
  graph.addEdge('setup_sandbox', 'deploy_initial')
  graph.addEdge('deploy_initial', 'discover')
  graph.addEdge('discover', 'main_switch')

  graph.addConditionalEdges('main_switch', mainSwitchRoute, {
    all_passed: 'create_summary_mr',
    over_budget: 'finalize_failed',
    continue: 'pick_next_scenario',
  })

  graph.addEdge('pick_next_scenario', 'run_scenario')

  graph.addConditionalEdges('run_scenario', scenarioResultRoute, {
    pass: 'mark_green',
    fail: 'collect_evidence',
  })

  graph.addEdge('mark_green', 'main_switch')

  graph.addEdge('collect_evidence', 'reset_iteration_branch')
  graph.addEdge('reset_iteration_branch', 'e2e_fix_agent')

  graph.addConditionalEdges('e2e_fix_agent', fixResultRoute, {
    success: 'redeploy',
    failure: 'mark_unfixable',
  })

  graph.addEdge('redeploy', 'healthcheck')
  graph.addEdge('healthcheck', 'run_scenario')

  graph.addEdge('mark_unfixable', 'main_switch')

  graph.addEdge('create_summary_mr', 'teardown_sandbox')
  graph.addEdge('finalize_failed', 'teardown_sandbox')
  graph.addEdge('teardown_sandbox', END)

  return graph.compile()
}
```

注意事项：
- `main_switch` 节点本身是 pass-through（状态不变），路由逻辑全在 `mainSwitchRoute` 条件边函数里
- `run_scenario → healthcheck → run_scenario` 的自循环由 `healthcheck → run_scenario` 的边实现，`run_scenario` 节点内部负责 `attempt_number++`
- `teardown_sandbox` 是正常路径的最后节点；错误路径在 runner.ts 的 try/catch 里单独 best-effort 调用

- [ ] **Step 2: Commit**

```bash
git add src/e2e/pipeline-b/graph.ts
git commit -m "feat(e2e): Pipeline B LangGraph 图结构（条件边 + 自循环）"
```

---

### Task 3: runner.ts 入口

**Files:**
- 新建: `src/e2e/pipeline-b/runner.ts`

- [ ] **Step 1: 实现 runner.ts**

```typescript
// src/e2e/pipeline-b/runner.ts
import { buildPipelineBGraph } from './graph.js'
import { teardownSandboxNode } from './nodes/teardown-sandbox.js'
import { updateE2eRunStatus } from '../../db/repositories/e2e-runs.js'
import { countQueuedE2eRuns } from '../../db/repositories/e2e-runs.js'
import { PipelineBState, type PipelineBStateType, type GovernorState } from './types.js'

const MAX_QUEUED_RUNS = 2
const DEFAULT_GOVERNOR_LIMITS = {
  maxPerScenarioAttempts: 3,
  maxRunHours: 4,
  maxTotalAttempts: 30,
}

export interface RunPipelineBOptions {
  targetProjectId: string
  sourceBranch: string
  scenarioFilter?: { ids?: string[]; tags?: string[] }
  triggerType: 'manual' | 'api' | 'scheduled' | 'im'
  triggerActor?: string
  governorOverrides?: {
    maxPerScenarioAttempts?: number
    maxRunHours?: number
    maxTotalAttempts?: number
  }
}

export async function runPipelineB(opts: RunPipelineBOptions): Promise<{ runId: bigint; status: string }> {
  const queuedCount = await countQueuedE2eRuns(opts.targetProjectId)
  if (queuedCount >= MAX_QUEUED_RUNS) {
    throw new Error(
      `当前已有 ${queuedCount} 个 run 在等待，请稍后再试或 abort 现有 run（上限 ${MAX_QUEUED_RUNS}）`
    )
  }

  const limits = {
    ...DEFAULT_GOVERNOR_LIMITS,
    ...opts.governorOverrides,
  }

  const governorState: GovernorState = {
    runStartedAt: Date.now(),
    totalAttempts: 0,
    perScenarioAttempts: {},
    limits,
  }

  const initialState: Partial<PipelineBStateType> = {
    runId: 0n,
    sandboxId: null,
    targetProjectId: opts.targetProjectId,
    sourceBranch: opts.sourceBranch,
    iterationBranch: '',
    sandboxHandle: null,
    pendingScenarios: [],
    currentScenario: null,
    currentScenarioRunId: null,
    lastScenarioResult: null,
    lastFixResult: null,
    evidenceDirTemp: null,
    governorState,
    summaryMrUrl: null,
    errorMessage: null,
  }

  const graph = buildPipelineBGraph()
  let lastKnownState: Partial<PipelineBStateType> = initialState
  let finalStatus = 'aborted'

  try {
    const result = await graph.invoke(initialState, { recursionLimit: 200 }) as PipelineBStateType
    lastKnownState = result
    const pending = result.pendingScenarios ?? []
    finalStatus = pending.length === 0 ? 'passed' : 'failed'
    return { runId: result.runId, status: finalStatus }
  } catch (err) {
    const runId = (lastKnownState as PipelineBStateType).runId
    if (runId) {
      await updateE2eRunStatus(runId, 'aborted', { abortReason: String(err) })
    }
    await teardownSandboxNode(lastKnownState as PipelineBStateType).catch(() => undefined)
    throw err
  }
}
```

`countQueuedE2eRuns` 查询排队中的 run 数（`status IN ('pending', 'running')`），需要在 `src/db/repositories/e2e-runs.ts` 里新增：

```typescript
// 在 src/db/repositories/e2e-runs.ts 追加
export async function countQueuedE2eRuns(targetProjectId: string): Promise<number> {
  const { rows } = await db.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM e2e_runs
      WHERE target_project_id = $1
        AND status IN ('pending', 'running', 'awaiting_fix')`,
    [targetProjectId]
  )
  return parseInt(rows[0].count, 10)
}
```

- [ ] **Step 2: Commit**

```bash
git add src/e2e/pipeline-b/runner.ts src/db/repositories/e2e-runs.ts
git commit -m "feat(e2e): Pipeline B runner 入口（队列限制 + try/catch teardown 兜底）"
```

---

### Task 4: 集成测试（mock 所有节点跑完整图）

**Files:**
- 新建: `src/__tests__/integration/pipeline-b-graph.test.ts`

- [ ] **Step 1: 写集成测试**

```typescript
// src/__tests__/integration/pipeline-b-graph.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PipelineBStateType, ScenarioInfo } from '../../e2e/pipeline-b/types.js'

vi.mock('../../e2e/pipeline-b/nodes/init-run.js', () => ({
  initRunNode: vi.fn(),
}))
vi.mock('../../e2e/pipeline-b/nodes/setup-sandbox.js', () => ({
  setupSandboxNode: vi.fn(),
}))
vi.mock('../../e2e/pipeline-b/nodes/deploy-initial.js', () => ({
  deployInitialNode: vi.fn(),
}))
vi.mock('../../e2e/pipeline-b/nodes/discover.js', () => ({
  discoverNode: vi.fn(),
}))
vi.mock('../../e2e/pipeline-b/nodes/pick-next-scenario.js', () => ({
  pickNextScenarioNode: vi.fn(),
}))
vi.mock('../../e2e/pipeline-b/nodes/run-scenario.js', () => ({
  runScenarioNode: vi.fn(),
}))
vi.mock('../../e2e/pipeline-b/nodes/collect-evidence.js', () => ({
  collectEvidenceNode: vi.fn(),
}))
vi.mock('../../e2e/pipeline-b/nodes/reset-iteration-branch.js', () => ({
  resetIterationBranchNode: vi.fn(),
}))
vi.mock('../../e2e/pipeline-b/nodes/e2e-fix-agent.js', () => ({
  e2eFixAgentNode: vi.fn(),
}))
vi.mock('../../e2e/pipeline-b/nodes/redeploy.js', () => ({
  redeployNode: vi.fn(),
}))
vi.mock('../../e2e/pipeline-b/nodes/healthcheck.js', () => ({
  healthcheckNode: vi.fn(),
}))
vi.mock('../../e2e/pipeline-b/nodes/mark-green.js', () => ({
  markGreenNode: vi.fn(),
}))
vi.mock('../../e2e/pipeline-b/nodes/mark-unfixable.js', () => ({
  markUnfixableNode: vi.fn(),
}))
vi.mock('../../e2e/pipeline-b/nodes/create-summary-mr.js', () => ({
  createSummaryMrNode: vi.fn(),
}))
vi.mock('../../e2e/pipeline-b/nodes/finalize-failed.js', () => ({
  finalizeFailed: vi.fn(),
}))
vi.mock('../../e2e/pipeline-b/nodes/teardown-sandbox.js', () => ({
  teardownSandboxNode: vi.fn(),
}))

import { buildPipelineBGraph } from '../../e2e/pipeline-b/graph.js'
import { initRunNode } from '../../e2e/pipeline-b/nodes/init-run.js'
import { setupSandboxNode } from '../../e2e/pipeline-b/nodes/setup-sandbox.js'
import { deployInitialNode } from '../../e2e/pipeline-b/nodes/deploy-initial.js'
import { discoverNode } from '../../e2e/pipeline-b/nodes/discover.js'
import { pickNextScenarioNode } from '../../e2e/pipeline-b/nodes/pick-next-scenario.js'
import { runScenarioNode } from '../../e2e/pipeline-b/nodes/run-scenario.js'
import { collectEvidenceNode } from '../../e2e/pipeline-b/nodes/collect-evidence.js'
import { resetIterationBranchNode } from '../../e2e/pipeline-b/nodes/reset-iteration-branch.js'
import { e2eFixAgentNode } from '../../e2e/pipeline-b/nodes/e2e-fix-agent.js'
import { redeployNode } from '../../e2e/pipeline-b/nodes/redeploy.js'
import { healthcheckNode } from '../../e2e/pipeline-b/nodes/healthcheck.js'
import { markGreenNode } from '../../e2e/pipeline-b/nodes/mark-green.js'
import { markUnfixableNode } from '../../e2e/pipeline-b/nodes/mark-unfixable.js'
import { createSummaryMrNode } from '../../e2e/pipeline-b/nodes/create-summary-mr.js'
import { finalizeFailed } from '../../e2e/pipeline-b/nodes/finalize-failed.js'
import { teardownSandboxNode } from '../../e2e/pipeline-b/nodes/teardown-sandbox.js'

const scenario1: ScenarioInfo = { id: 'login-success', name: 'Login success', tags: ['smoke'] }
const scenario2: ScenarioInfo = { id: 'create-prd', name: 'Create PRD', tags: ['smoke'] }

function baseGovernorState() {
  return {
    runStartedAt: Date.now(),
    totalAttempts: 0,
    perScenarioAttempts: {} as Record<string, number>,
    limits: { maxPerScenarioAttempts: 3, maxRunHours: 4, maxTotalAttempts: 30 },
  }
}

function baseInitialState(): Partial<PipelineBStateType> {
  return {
    runId: 0n,
    sandboxId: null,
    targetProjectId: 'chatops',
    sourceBranch: 'main',
    iterationBranch: '',
    sandboxHandle: null,
    pendingScenarios: [],
    currentScenario: null,
    currentScenarioRunId: null,
    lastScenarioResult: null,
    lastFixResult: null,
    evidenceDirTemp: null,
    governorState: baseGovernorState(),
    summaryMrUrl: null,
    errorMessage: null,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(initRunNode as ReturnType<typeof vi.fn>).mockResolvedValue({ runId: 42n, iterationBranch: 'test-iter/42' })
  ;(setupSandboxNode as ReturnType<typeof vi.fn>).mockResolvedValue({ sandboxId: 1n, sandboxHandle: { envId: 'test-42', kind: 'docker-compose-local', endpoints: {}, internalRefs: {}, containerId: 'c1' } })
  ;(deployInitialNode as ReturnType<typeof vi.fn>).mockResolvedValue({})
  ;(teardownSandboxNode as ReturnType<typeof vi.fn>).mockResolvedValue({})
  ;(createSummaryMrNode as ReturnType<typeof vi.fn>).mockResolvedValue({ summaryMrUrl: 'https://gitlab/mr/1' })
  ;(finalizeFailed as ReturnType<typeof vi.fn>).mockResolvedValue({})
})

describe('Pipeline B 图集成测试', () => {
  it('全绿路径: 两个 scenario 全部 pass', async () => {
    ;(discoverNode as ReturnType<typeof vi.fn>).mockResolvedValue({
      pendingScenarios: [scenario1, scenario2],
    })

    let callCount = 0
    ;(pickNextScenarioNode as ReturnType<typeof vi.fn>).mockImplementation(
      (state: PipelineBStateType) => {
        callCount++
        const scenario = state.pendingScenarios[0]
        return { currentScenario: scenario, currentScenarioRunId: BigInt(callCount) }
      }
    )
    ;(runScenarioNode as ReturnType<typeof vi.fn>).mockResolvedValue({
      lastScenarioResult: 'pass',
    })
    ;(markGreenNode as ReturnType<typeof vi.fn>).mockImplementation(
      (state: PipelineBStateType) => ({
        pendingScenarios: state.pendingScenarios.slice(1),
        governorState: {
          ...state.governorState,
          totalAttempts: state.governorState.totalAttempts + 1,
        },
      })
    )

    const graph = buildPipelineBGraph()
    const result = await graph.invoke(baseInitialState(), { recursionLimit: 50 }) as PipelineBStateType

    expect(result.pendingScenarios).toHaveLength(0)
    expect(createSummaryMrNode).toHaveBeenCalledTimes(1)
    expect(finalizeFailed).not.toHaveBeenCalled()
    expect(teardownSandboxNode).toHaveBeenCalledTimes(1)
    expect(markGreenNode).toHaveBeenCalledTimes(2)
  })

  it('修复路径: 一次失败 → fix 成功 → redeploy → pass', async () => {
    ;(discoverNode as ReturnType<typeof vi.fn>).mockResolvedValue({
      pendingScenarios: [scenario1],
    })
    ;(pickNextScenarioNode as ReturnType<typeof vi.fn>).mockResolvedValue({
      currentScenario: scenario1,
      currentScenarioRunId: 1n,
    })

    let runCount = 0
    ;(runScenarioNode as ReturnType<typeof vi.fn>).mockImplementation(() => {
      runCount++
      return { lastScenarioResult: runCount === 1 ? 'fail' : 'pass' }
    })
    ;(collectEvidenceNode as ReturnType<typeof vi.fn>).mockResolvedValue({ evidenceDirTemp: '/tmp/evidence' })
    ;(resetIterationBranchNode as ReturnType<typeof vi.fn>).mockResolvedValue({})
    ;(e2eFixAgentNode as ReturnType<typeof vi.fn>).mockResolvedValue({
      lastFixResult: { success: true, fixCommitSha: 'abc123', verdict: 'product_bug', rootCauseSummary: 'null check', fixedFiles: [], failureReason: null },
    })
    ;(redeployNode as ReturnType<typeof vi.fn>).mockResolvedValue({})
    ;(healthcheckNode as ReturnType<typeof vi.fn>).mockResolvedValue({})
    ;(markGreenNode as ReturnType<typeof vi.fn>).mockImplementation(
      (state: PipelineBStateType) => ({
        pendingScenarios: state.pendingScenarios.slice(1),
        governorState: { ...state.governorState, totalAttempts: state.governorState.totalAttempts + 1 },
      })
    )

    const graph = buildPipelineBGraph()
    const result = await graph.invoke(baseInitialState(), { recursionLimit: 50 }) as PipelineBStateType

    expect(e2eFixAgentNode).toHaveBeenCalledTimes(1)
    expect(redeployNode).toHaveBeenCalledTimes(1)
    expect(healthcheckNode).toHaveBeenCalledTimes(1)
    expect(runScenarioNode).toHaveBeenCalledTimes(2)
    expect(markGreenNode).toHaveBeenCalledTimes(1)
    expect(result.pendingScenarios).toHaveLength(0)
    expect(createSummaryMrNode).toHaveBeenCalledTimes(1)
  })

  it('mark_unfixable 路径: fix 失败 → scenario 标记 unfixable → 全部 unfixable → finalize_failed', async () => {
    ;(discoverNode as ReturnType<typeof vi.fn>).mockResolvedValue({
      pendingScenarios: [scenario1],
    })
    ;(pickNextScenarioNode as ReturnType<typeof vi.fn>).mockResolvedValue({
      currentScenario: scenario1,
      currentScenarioRunId: 1n,
    })
    ;(runScenarioNode as ReturnType<typeof vi.fn>).mockResolvedValue({ lastScenarioResult: 'fail' })
    ;(collectEvidenceNode as ReturnType<typeof vi.fn>).mockResolvedValue({ evidenceDirTemp: '/tmp/evidence' })
    ;(resetIterationBranchNode as ReturnType<typeof vi.fn>).mockResolvedValue({})
    ;(e2eFixAgentNode as ReturnType<typeof vi.fn>).mockResolvedValue({
      lastFixResult: { success: false, fixCommitSha: null, verdict: 'uncertain', rootCauseSummary: '', fixedFiles: [], failureReason: 'LLM 放弃' },
    })
    ;(markUnfixableNode as ReturnType<typeof vi.fn>).mockImplementation(
      (state: PipelineBStateType) => ({
        pendingScenarios: state.pendingScenarios.filter(s => s.id !== state.currentScenario?.id),
      })
    )

    const graph = buildPipelineBGraph()
    const result = await graph.invoke(baseInitialState(), { recursionLimit: 50 }) as PipelineBStateType

    expect(markUnfixableNode).toHaveBeenCalledTimes(1)
    expect(finalizeFailed).toHaveBeenCalledTimes(1)
    expect(createSummaryMrNode).not.toHaveBeenCalled()
    expect(teardownSandboxNode).toHaveBeenCalledTimes(1)
  })

  it('governor 超限: totalAttempts 超过 maxTotalAttempts → finalize_failed', async () => {
    const overBudgetGovernorState = {
      runStartedAt: Date.now(),
      totalAttempts: 30,
      perScenarioAttempts: {},
      limits: { maxPerScenarioAttempts: 3, maxRunHours: 4, maxTotalAttempts: 30 },
    }
    ;(discoverNode as ReturnType<typeof vi.fn>).mockResolvedValue({
      pendingScenarios: [scenario1],
      governorState: overBudgetGovernorState,
    })

    const graph = buildPipelineBGraph()
    const result = await graph.invoke(
      { ...baseInitialState(), governorState: overBudgetGovernorState },
      { recursionLimit: 50 }
    ) as PipelineBStateType

    expect(finalizeFailed).toHaveBeenCalledTimes(1)
    expect(createSummaryMrNode).not.toHaveBeenCalled()
    expect(pickNextScenarioNode).not.toHaveBeenCalled()
    expect(teardownSandboxNode).toHaveBeenCalledTimes(1)
  })

  it('governor 超限: run 超过 maxRunHours → finalize_failed', async () => {
    const fourHoursAgo = Date.now() - 4 * 3600 * 1000 - 1
    const expiredGovernorState = {
      runStartedAt: fourHoursAgo,
      totalAttempts: 0,
      perScenarioAttempts: {},
      limits: { maxPerScenarioAttempts: 3, maxRunHours: 4, maxTotalAttempts: 30 },
    }
    ;(discoverNode as ReturnType<typeof vi.fn>).mockResolvedValue({
      pendingScenarios: [scenario1],
    })

    const graph = buildPipelineBGraph()
    await graph.invoke(
      { ...baseInitialState(), governorState: expiredGovernorState },
      { recursionLimit: 50 }
    )

    expect(finalizeFailed).toHaveBeenCalledTimes(1)
    expect(createSummaryMrNode).not.toHaveBeenCalled()
  })

  it('空 scenario 列表: discover 返回空 → 直接 create_summary_mr', async () => {
    ;(discoverNode as ReturnType<typeof vi.fn>).mockResolvedValue({
      pendingScenarios: [],
    })

    const graph = buildPipelineBGraph()
    await graph.invoke(baseInitialState(), { recursionLimit: 50 })

    expect(createSummaryMrNode).toHaveBeenCalledTimes(1)
    expect(pickNextScenarioNode).not.toHaveBeenCalled()
    expect(finalizeFailed).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 跑集成测试确认绿**

```bash
npx vitest run src/__tests__/integration/pipeline-b-graph.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add src/__tests__/integration/pipeline-b-graph.test.ts
git commit -m "feat(e2e): Pipeline B 图集成测试（mock 所有节点）"
```

---

## 完整验收

```bash
npx vitest run src/__tests__/unit/governor.test.ts
npx vitest run src/__tests__/integration/pipeline-b-graph.test.ts
```

两个测试文件全绿，无 TypeScript 编译错误（`./test.sh --typecheck`）即为完成。

## 关键约定备忘

- `main_switch` 节点本身是透传节点，所有路由判断在 `mainSwitchRoute` 条件边函数里
- `governorCheck` 是纯函数，不读 DB，不改 state；副作用统一在各节点实现
- `isScenarioOverBudget` 供 `mark_unfixable` 节点使用，governor.ts 只导出这两个函数
- teardown_sandbox 在正常路径作为图最后一个节点；在异常路径在 runner.ts 的 catch 里 best-effort 调用（swallow error）
- `recursionLimit: 200` 对应最多 30 个 scenario × 最多 3 次 fix attempt × 5 个节点/attempt + 开销 = 约 500，若 scenarios 上限 30 需在 runner.ts 调大
- 图不依赖 DB 直连，所有 DB 访问封装在各节点实现里，集成测试通过 mock 节点绕开 DB
