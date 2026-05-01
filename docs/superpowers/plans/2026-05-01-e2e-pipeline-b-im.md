# E2E Pipeline B — IM 入口 + 通知 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 IM 单句触发 e2e run（@bot 跑 chatops e2e [--tag=...]）和关键节点 IM 推送通知。

**Architecture:** coordinator.ts 注册 e2e_run handler 解析单句语法；im-notifier.ts 导出按节点维度的通知函数；IMAdapter 通过 PipelineBState.imContext 传递到节点（不序列化，仅内存）。

**Tech Stack:** TypeScript, Vitest

**前置条件:** Plan B5（runPipelineB runner，需要加 imContext + existingRunId 支持）完成

---

## 文件地图

| 操作 | 路径 |
|---|---|
| 新建 | `src/e2e/pipeline-b/im-notifier.ts` |
| 新建 | `src/__tests__/unit/e2e-im-notifier.test.ts` |
| 修改 | `src/e2e/pipeline-b/types.ts`（加 imContext 字段） |
| 修改 | `src/e2e/pipeline-b/runner.ts`（加 imContext + existingRunId 支持） |
| 修改 | `src/agent/coordinator.ts`（注册 e2e_run handler） |

---

### Task 1: im-notifier.ts — 单测 + 实现

**Files:**
- 新建: `src/e2e/pipeline-b/im-notifier.ts`
- 新建: `src/__tests__/unit/e2e-im-notifier.test.ts`

- [ ] **Step 1: 先写单测（red phase）**

```typescript
// src/__tests__/unit/e2e-im-notifier.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { IMAdapter } from '../../adapters/im/types.js'
import {
  notifyRunStarted,
  notifyScenarioFailed,
  notifyBugfixComplete,
  notifyRunPassed,
  notifyRunFailed,
  notifyRunAborted,
  notifyGovernorUnfixable,
} from '../../e2e/pipeline-b/im-notifier.js'
import type { ImNotifyOptions } from '../../e2e/pipeline-b/im-notifier.js'

function makeMockAdapter(): IMAdapter {
  return {
    platform: 'dingtalk',
    onMessage: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendCard: vi.fn().mockResolvedValue(undefined),
    sendDirectMessage: vi.fn().mockResolvedValue(undefined),
    getUserInfo: vi.fn(),
    onCardAction: vi.fn(),
    handleWebhook: vi.fn(),
  } as unknown as IMAdapter
}

function makeOpts(adapter: IMAdapter): ImNotifyOptions {
  return { adapter, groupId: 'group-123', runId: 42n }
}

describe('notifyRunStarted', () => {
  it('发送含 runId 和 totalScenarios 的消息', async () => {
    const adapter = makeMockAdapter()
    await notifyRunStarted(makeOpts(adapter), 15)
    expect(adapter.sendMessage).toHaveBeenCalledOnce()
    const call = vi.mocked(adapter.sendMessage).mock.calls[0]
    expect(call[0]).toEqual({ type: 'group', id: 'group-123' })
    expect(call[1].text).toContain('42')
    expect(call[1].text).toContain('15')
    expect(call[1].text).toContain('✅')
  })

  it('totalScenarios=0 时消息仍不报错（discover 前的初始消息）', async () => {
    const adapter = makeMockAdapter()
    await notifyRunStarted(makeOpts(adapter), 0)
    expect(adapter.sendMessage).toHaveBeenCalledOnce()
  })

  it('包含 admin URL 链接', async () => {
    const adapter = makeMockAdapter()
    await notifyRunStarted(makeOpts(adapter), 5)
    const text = vi.mocked(adapter.sendMessage).mock.calls[0][1].text
    expect(text).toMatch(/http/)
    expect(text).toContain('42')
  })
})

describe('notifyScenarioFailed', () => {
  it('发送含 scenarioId 的失败消息', async () => {
    const adapter = makeMockAdapter()
    await notifyScenarioFailed(makeOpts(adapter), 'login-success')
    const text = vi.mocked(adapter.sendMessage).mock.calls[0][1].text
    expect(text).toContain('login-success')
    expect(text).toContain('42')
    expect(text).toContain('📊')
  })
})

describe('notifyBugfixComplete', () => {
  it('发送含 scenarioId 的修复完成消息', async () => {
    const adapter = makeMockAdapter()
    await notifyBugfixComplete(makeOpts(adapter), 'approval-flow')
    const text = vi.mocked(adapter.sendMessage).mock.calls[0][1].text
    expect(text).toContain('approval-flow')
    expect(text).toContain('42')
    expect(text).toContain('🔧')
  })
})

describe('notifyRunPassed', () => {
  it('包含 fixedCount 和 mrUrl', async () => {
    const adapter = makeMockAdapter()
    await notifyRunPassed(makeOpts(adapter), 8, 'https://gitlab.example.com/mr/789')
    const text = vi.mocked(adapter.sendMessage).mock.calls[0][1].text
    expect(text).toContain('PASSED')
    expect(text).toContain('8')
    expect(text).toContain('https://gitlab.example.com/mr/789')
    expect(text).toContain('✅')
  })

  it('mrUrl=null 时不报错', async () => {
    const adapter = makeMockAdapter()
    await notifyRunPassed(makeOpts(adapter), 0, null)
    expect(adapter.sendMessage).toHaveBeenCalledOnce()
  })
})

describe('notifyRunFailed', () => {
  it('包含 reason 和 FAILED 标记', async () => {
    const adapter = makeMockAdapter()
    await notifyRunFailed(makeOpts(adapter), 'governor 超限（4h）')
    const text = vi.mocked(adapter.sendMessage).mock.calls[0][1].text
    expect(text).toContain('FAILED')
    expect(text).toContain('governor 超限（4h）')
    expect(text).toContain('❌')
  })
})

describe('notifyRunAborted', () => {
  it('包含 reason 和 aborted 语义标记', async () => {
    const adapter = makeMockAdapter()
    await notifyRunAborted(makeOpts(adapter), '沙盒启动超时')
    const text = vi.mocked(adapter.sendMessage).mock.calls[0][1].text
    expect(text).toContain('42')
    expect(text).toContain('沙盒启动超时')
  })
})

describe('notifyGovernorUnfixable', () => {
  it('包含 scenarioId 和重试次数语义', async () => {
    const adapter = makeMockAdapter()
    await notifyGovernorUnfixable(makeOpts(adapter), 'login-success')
    const text = vi.mocked(adapter.sendMessage).mock.calls[0][1].text
    expect(text).toContain('login-success')
    expect(text).toContain('⚠️')
  })
})

describe('sendMessage 异常处理', () => {
  it('sendMessage 抛出时函数不向上抛（fire-and-forget 安全）', async () => {
    const adapter = makeMockAdapter()
    vi.mocked(adapter.sendMessage).mockRejectedValue(new Error('network error'))
    await expect(notifyRunStarted(makeOpts(adapter), 5)).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: 实现 im-notifier.ts**

```typescript
// src/e2e/pipeline-b/im-notifier.ts
import type { IMAdapter } from '../../adapters/im/types.js'

export interface ImNotifyOptions {
  adapter: IMAdapter
  groupId: string
  runId: bigint
}

function adminUrl(): string {
  return process.env.CHATOPS_ADMIN_URL ?? 'http://localhost:3000'
}

async function send(opts: ImNotifyOptions, text: string): Promise<void> {
  try {
    await opts.adapter.sendMessage({ type: 'group', id: opts.groupId }, { text })
  } catch (err) {
    console.warn(`[e2e-im-notifier] sendMessage failed runId=${opts.runId}:`, err)
  }
}

export async function notifyRunStarted(opts: ImNotifyOptions, totalScenarios: number): Promise<void> {
  const scenariosText = totalScenarios > 0 ? ` · 跑 ${totalScenarios} 个场景` : ''
  const url = `${adminUrl()}/e2e-runs/${opts.runId}`
  await send(opts, `✅ 已启动 Run #${opts.runId}${scenariosText} · ▶ ${url}`)
}

export async function notifyScenarioFailed(opts: ImNotifyOptions, scenarioId: string): Promise<void> {
  await send(opts, `📊 Run #${opts.runId} · ${scenarioId} 失败 · 启动 AI 修复`)
}

export async function notifyBugfixComplete(opts: ImNotifyOptions, scenarioId: string): Promise<void> {
  await send(opts, `🔧 Run #${opts.runId} · ${scenarioId} 已修复，重新部署沙盒并重试中`)
}

export async function notifyRunPassed(opts: ImNotifyOptions, fixedCount: number, mrUrl: string | null): Promise<void> {
  const fixText = fixedCount > 0 ? ` · 共修复 ${fixedCount} 个 bug` : ''
  const mrText = mrUrl ? `\n   汇总 MR ▶ ${mrUrl}` : ''
  await send(opts, `✅ Run #${opts.runId} PASSED · 沙盒已销毁${fixText}${mrText}`)
}

export async function notifyRunFailed(opts: ImNotifyOptions, reason: string): Promise<void> {
  await send(opts, `❌ Run #${opts.runId} FAILED · ${reason}`)
}

export async function notifyRunAborted(opts: ImNotifyOptions, reason: string): Promise<void> {
  await send(opts, `❌ Run #${opts.runId} 已中止 · ${reason}`)
}

export async function notifyGovernorUnfixable(opts: ImNotifyOptions, scenarioId: string): Promise<void> {
  await send(opts, `⚠️ Run #${opts.runId} · ${scenarioId} 无法修复（已重试 3 次），继续其他场景`)
}
```

- [ ] **Step 3: 跑单测确认绿**

```bash
npx vitest run src/__tests__/unit/e2e-im-notifier.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/e2e/pipeline-b/im-notifier.ts src/__tests__/unit/e2e-im-notifier.test.ts
git commit -m "feat(e2e): Pipeline B im-notifier — 关键节点 IM 推送通知（单测）"
```

---

### Task 2: coordinator.ts — 注册 e2e_run handler

**Files:**
- 修改: `src/agent/coordinator.ts`

handler 硬编码在 coordinator.ts 末尾——不走 `im_triggers` 表，不走 `PIPELINE_DAG_HANDLERS` 分流，直接用 `registerCapabilityHandler` 注册独立路径。

- [ ] **Step 1: 在 coordinator.ts 末尾添加 parseE2eImCommand + handler**

在文件末尾（`notifyDm` 函数后）追加以下内容：

```typescript
// src/agent/coordinator.ts（末尾追加）
import { createE2eRun } from '../db/repositories/e2e-runs.js'
import { notifyRunStarted, notifyRunAborted } from '../e2e/pipeline-b/im-notifier.js'
import type { ImNotifyOptions } from '../e2e/pipeline-b/im-notifier.js'

export interface ParsedE2eCommand {
  projectId: string
  sourceBranch: string
  scenarioFilter?: { ids?: string[]; tags?: string[] }
}

export function parseE2eImCommand(messageText: string): ParsedE2eCommand | null {
  const normalized = messageText.replace(/^@\S+\s*/, '').trim()
  const hasKeyword =
    /跑\s*chatops\s*e2e/i.test(normalized) ||
    /run\s+chatops\s+e2e/i.test(normalized)
  if (!hasKeyword) return null

  const tagMatch = normalized.match(/--tag=(\S+)/)
  const idMatch = normalized.match(/--id=(\S+)/)
  const branchMatch = normalized.match(/--branch=(\S+)/)

  const tags = tagMatch ? [tagMatch[1]] : undefined
  const ids = idMatch ? [idMatch[1]] : undefined
  const scenarioFilter = tags || ids ? { tags, ids } : undefined

  return {
    projectId: 'chatops',
    sourceBranch: branchMatch ? branchMatch[1] : 'main',
    scenarioFilter,
  }
}

registerCapabilityHandler('e2e_run', async (opts: TriggerOptions) => {
  const { context } = opts
  const parsed = parseE2eImCommand(context.messageText ?? '')
  if (!parsed) {
    return {
      success: false,
      error: '命令格式：@bot 跑 chatops e2e [--tag=<tag>] [--id=<id>] [--branch=<branch>]',
    }
  }

  if (!context.adapter) {
    return { success: false, error: 'e2e_run handler 需要 IMAdapter（context.adapter 为空）' }
  }

  const run = await createE2eRun({
    targetProjectId: parsed.projectId,
    triggerType: 'im',
    triggerActor: context.initiatorId,
    sourceBranch: parsed.sourceBranch,
    iterationBranch: `test-iter/init`,
    scenarioFilter: parsed.scenarioFilter ?? null,
  })

  const notifyOpts: ImNotifyOptions = {
    adapter: context.adapter,
    groupId: context.groupId,
    runId: run.id,
  }

  const { runPipelineB } = await import('../e2e/pipeline-b/runner.js')

  runPipelineB({
    targetProjectId: parsed.projectId,
    sourceBranch: parsed.sourceBranch,
    scenarioFilter: parsed.scenarioFilter,
    triggerType: 'im',
    triggerActor: context.initiatorId,
    existingRunId: run.id,
    imContext: { adapter: context.adapter, groupId: context.groupId },
  }).catch((err: Error) => {
    notifyRunAborted(notifyOpts, err.message).catch(() => {})
  })

  await notifyRunStarted(notifyOpts, 0)
  return { success: true, data: { runId: String(run.id) } }
})
```

注意：`context.messageText` 在 `TaskContext` 现有定义中未列出——需确认 coordinator 的调用方（session-manager）是否已传入。若 `TaskContext` 缺少该字段，Step 2 同步补上。

- [ ] **Step 2: 确认/补充 TaskContext.messageText 字段**

读 `src/agent/tools/types.ts`，确认 `TaskContext` 接口包含 `messageText?: string`（IM 消息原文）和 `adapter?: IMAdapter`。若缺失则补上：

```typescript
// src/agent/tools/types.ts（在 TaskContext 接口里补充）
messageText?: string     // 触发本次任务的原始 IM 消息文本
adapter?: IMAdapter      // IM 适配器，非 IM 触发时为 undefined
```

若 `adapter` 已有，仅补 `messageText`。补充后在文件顶部确认 `IMAdapter` 已 import（`import type { IMAdapter } from '../../adapters/im/types.js'`）。

- [ ] **Step 3: 类型检查**

```bash
./test.sh --typecheck
```

修复所有类型错误后继续。

- [ ] **Step 4: Commit**

```bash
git add src/agent/coordinator.ts src/agent/tools/types.ts
git commit -m "feat(e2e): coordinator 注册 e2e_run handler（parseE2eImCommand + fire-and-forget）"
```

---

### Task 3: PipelineBState 加 imContext + runner.ts 传递 + 关键节点调通知

**Files:**
- 修改: `src/e2e/pipeline-b/types.ts`（加 imContext 字段）
- 修改: `src/e2e/pipeline-b/runner.ts`（加 imContext + existingRunId 参数）
- 修改: `src/e2e/pipeline-b/nodes/discover.ts`（discover 后补发 notifyRunStarted 含真实数量）
- 修改: `src/e2e/pipeline-b/nodes/run-scenario.ts` 或 `src/e2e/pipeline-b/nodes/mark-green.ts`（场景失败时推 notifyScenarioFailed）
- 修改: `src/e2e/pipeline-b/nodes/redeploy.ts` 或 `src/e2e/pipeline-b/nodes/e2e-fix-agent.ts`（修复完成后推 notifyBugfixComplete）
- 修改: `src/e2e/pipeline-b/nodes/create-summary-mr.ts`（全绿后推 notifyRunPassed）
- 修改: `src/e2e/pipeline-b/nodes/finalize-failed.ts`（governor 超限时推 notifyRunFailed）
- 修改: `src/e2e/pipeline-b/nodes/mark-unfixable.ts`（场景无法修复时推 notifyGovernorUnfixable）

#### Step 1: PipelineBState 加 imContext

`imContext` 持有 `IMAdapter` 引用，不序列化到 DB，仅内存存活。LangGraph Annotation 用 `any` 类型绕开 LangGraph 序列化约束（Annotation 的 reducer 仍是 replace 语义）：

```typescript
// src/e2e/pipeline-b/types.ts（在 PipelineBState Annotation.Root 里追加）
import type { IMAdapter } from '../../adapters/im/types.js'

export interface ImContext {
  adapter: IMAdapter
  groupId: string
}

// 在 PipelineBState = Annotation.Root({ ... }) 的最后一个字段后追加：
imContext: Annotation<ImContext | null>({ default: () => null, reducer: (_, v) => v }),
```

- [ ] **Step 1: 修改 types.ts 加 imContext**

读 `src/e2e/pipeline-b/types.ts`，在 `PipelineBState` 的 `Annotation.Root({...})` 末尾追加 `imContext` 字段（如上）。同时在文件顶部添加 `import type { IMAdapter } from '../../adapters/im/types.js'`（若已有则跳过）和 `ImContext` 接口定义。

#### Step 2: runner.ts 接收并传递 imContext + existingRunId

`runPipelineB` 当前签名（来自 Plan B5）：

```typescript
async function runPipelineB(opts: {
  targetProjectId: string
  sourceBranch: string
  scenarioFilter?: { ids?: string[]; tags?: string[] }
  triggerType: 'manual' | 'api' | 'scheduled' | 'im'
  triggerActor?: string
}): Promise<{ runId: bigint; status: string }>
```

扩展为：

```typescript
// src/e2e/pipeline-b/runner.ts（修改 opts 接口）
import type { ImContext } from './types.js'

interface RunPipelineBOpts {
  targetProjectId: string
  sourceBranch: string
  scenarioFilter?: { ids?: string[]; tags?: string[] }
  triggerType: 'manual' | 'api' | 'scheduled' | 'im'
  triggerActor?: string
  existingRunId?: bigint        // ← 新增：coordinator 已预创建 run 时传入，跳过 init_run 的 createE2eRun
  imContext?: ImContext          // ← 新增：IM 触发时携带的 adapter + groupId
}
```

在 `runPipelineB` 内部：
1. 若 `opts.existingRunId` 存在，把它写入 `initialState.runId`，并在 `init_run` 节点里判断 `state.runId !== 0n` 时跳过 `createE2eRun`（直接 `updateE2eRunStatus(state.runId, 'running')`）
2. 把 `opts.imContext ?? null` 写入 `initialState.imContext`

- [ ] **Step 2: 修改 runner.ts 加 existingRunId + imContext 支持**

读 `src/e2e/pipeline-b/runner.ts`，在 opts 类型中加 `existingRunId?: bigint` 和 `imContext?: ImContext`，在 `initialState` 构建处加：

```typescript
const initialState: Partial<PipelineBStateType> = {
  targetProjectId: opts.targetProjectId,
  sourceBranch: opts.sourceBranch,
  iterationBranch: `test-iter/${opts.existingRunId ?? 'init'}`,
  scenarioFilter: opts.scenarioFilter ?? null,
  ...(opts.existingRunId ? { runId: opts.existingRunId } : {}),
  imContext: opts.imContext ?? null,
}
```

#### Step 3: init_run 节点跳过重复 createE2eRun

- [ ] **Step 3: 修改 nodes/init-run.ts**

读 `src/e2e/pipeline-b/nodes/init-run.ts`，在节点函数顶部加判断：

```typescript
// src/e2e/pipeline-b/nodes/init-run.ts（在节点函数顶部）
if (state.runId && state.runId !== 0n) {
  // existingRunId 已由 runner 传入（coordinator handler 预创建），跳过 createE2eRun
  await updateE2eRunStatus(state.runId, 'running')
  const project = await getE2eTargetProject(state.targetProjectId)
  if (!project) throw new Error(`e2e target project not found: ${state.targetProjectId}`)
  return {
    iterationBranch: `test-iter/${state.runId}`,
    projectScripts: project.scripts,
  }
}
// 原有逻辑：createE2eRun + createIterationBranch ...
```

#### Step 4: discover 节点补发含真实数量的 notifyRunStarted

coordinator handler 在 `runId` 已知时立刻发一次初始消息（`totalScenarios=0`），discover 节点完成后补发一次含真实数量的版本：

- [ ] **Step 4: 修改 nodes/discover.ts**

读 `src/e2e/pipeline-b/nodes/discover.ts`，在节点函数末尾（scenarios 已解析、写回 state 之前）加：

```typescript
// src/e2e/pipeline-b/nodes/discover.ts（节点返回前）
import { notifyRunStarted } from '../im-notifier.js'

if (state.imContext) {
  notifyRunStarted(
    { adapter: state.imContext.adapter, groupId: state.imContext.groupId, runId: state.runId },
    scenarios.length,
  ).catch(() => {})
}
```

#### Step 5: collect-evidence 节点推 notifyScenarioFailed

场景失败且 evidence 收集完毕时，向群推 `notifyScenarioFailed`。该通知在 `collect_evidence` 节点发最合适（此时失败已确定）：

- [ ] **Step 5: 修改 nodes/collect-evidence.ts（或 run-scenario.ts）**

读节点文件，在 evidence 写入 DB 后（`upsertE2eScenarioRun` 调用后）添加：

```typescript
import { notifyScenarioFailed } from '../im-notifier.js'

if (state.imContext && state.currentScenario) {
  notifyScenarioFailed(
    { adapter: state.imContext.adapter, groupId: state.imContext.groupId, runId: state.runId },
    state.currentScenario.id,
  ).catch(() => {})
}
```

#### Step 6: e2e-fix-agent 节点成功后推 notifyBugfixComplete

`e2e_fix_agent` 节点在 fix 成功（`result.success === true`）时推修复完成消息：

- [ ] **Step 6: 修改 nodes/e2e-fix-agent.ts**

读节点文件，在 `if (result.success)` 分支（即进入 redeploy 路径前）添加：

```typescript
import { notifyBugfixComplete } from '../im-notifier.js'

if (result.success && state.imContext && state.currentScenario) {
  notifyBugfixComplete(
    { adapter: state.imContext.adapter, groupId: state.imContext.groupId, runId: state.runId },
    state.currentScenario.id,
  ).catch(() => {})
}
```

#### Step 7: mark-unfixable 节点推 notifyGovernorUnfixable

- [ ] **Step 7: 修改 nodes/mark-unfixable.ts**

读节点文件，在更新 scenario run 状态为 `unfixable` 后添加：

```typescript
import { notifyGovernorUnfixable } from '../im-notifier.js'

if (state.imContext && state.currentScenario) {
  notifyGovernorUnfixable(
    { adapter: state.imContext.adapter, groupId: state.imContext.groupId, runId: state.runId },
    state.currentScenario.id,
  ).catch(() => {})
}
```

#### Step 8: create-summary-mr 节点推 notifyRunPassed

- [ ] **Step 8: 修改 nodes/create-summary-mr.ts**

读节点文件，在 `updateE2eRunStatus(runId, 'passed', { summaryMrUrl })` 后添加：

```typescript
import { notifyRunPassed } from '../im-notifier.js'

const fixedCount = Object.values(state.governorState.perScenarioAttempts)
  .filter(n => n > 1).length

if (state.imContext) {
  notifyRunPassed(
    { adapter: state.imContext.adapter, groupId: state.imContext.groupId, runId: state.runId },
    fixedCount,
    mrUrl ?? null,
  ).catch(() => {})
}
```

#### Step 9: finalize-failed 节点推 notifyRunFailed

- [ ] **Step 9: 修改 nodes/finalize-failed.ts**

读节点文件，在更新 run status 为 `failed` 后添加：

```typescript
import { notifyRunFailed } from '../im-notifier.js'

if (state.imContext) {
  notifyRunFailed(
    { adapter: state.imContext.adapter, groupId: state.imContext.groupId, runId: state.runId },
    state.errorMessage ?? 'governor 超限',
  ).catch(() => {})
}
```

#### Step 10: teardown-sandbox（error 路径）推 notifyRunAborted

运行时抛出的意外错误在 teardown 节点或 runner.ts 的 catch 兜底处推 `notifyRunAborted`。runner.ts 中的 catch 块（Plan B5 已有）是最可靠的兜底位置，因为节点级错误会冒泡到这里：

- [ ] **Step 10: 修改 runner.ts 的 catch 块**

读 `src/e2e/pipeline-b/runner.ts`，在 `catch (err)` 块中添加（此处已有 teardown 逻辑）：

```typescript
// src/e2e/pipeline-b/runner.ts（在已有 catch 块里）
import { notifyRunAborted } from './im-notifier.js'

// catch 块末尾（teardown 之后）
if (opts.imContext) {
  const msg = err instanceof Error ? err.message : String(err)
  notifyRunAborted(
    { adapter: opts.imContext.adapter, groupId: opts.imContext.groupId, runId },
    msg,
  ).catch(() => {})
}
```

- [ ] **Step 11: 全量类型检查**

```bash
./test.sh --typecheck
```

修复所有类型错误后继续。

- [ ] **Step 12: 跑通知单测再确认**

```bash
npx vitest run src/__tests__/unit/e2e-im-notifier.test.ts
```

- [ ] **Step 13: Commit**

```bash
git add \
  src/e2e/pipeline-b/types.ts \
  src/e2e/pipeline-b/runner.ts \
  src/e2e/pipeline-b/nodes/init-run.ts \
  src/e2e/pipeline-b/nodes/discover.ts \
  src/e2e/pipeline-b/nodes/collect-evidence.ts \
  src/e2e/pipeline-b/nodes/e2e-fix-agent.ts \
  src/e2e/pipeline-b/nodes/mark-unfixable.ts \
  src/e2e/pipeline-b/nodes/create-summary-mr.ts \
  src/e2e/pipeline-b/nodes/finalize-failed.ts
git commit -m "feat(e2e): PipelineBState.imContext + 关键节点 IM 通知接入"
```

---

## 测试命令

```bash
npx vitest run src/__tests__/unit/e2e-im-notifier.test.ts
./test.sh --typecheck
```

---

## 关键约束备忘

- `IMAdapter` 只在内存 state 里（`PipelineBState.imContext`），不写 DB、不序列化
- 所有 `notifyXxx` 调用必须 `.catch(() => {})` — IM 发送失败不阻断主流程
- coordinator handler 用 `registerCapabilityHandler`，不走 `im_triggers` 表，不走 `PIPELINE_DAG_HANDLERS` 分流
- `parseE2eImCommand` 是纯函数，可独立单测
- `existingRunId` 传入时 `init_run` 节点跳过 `createE2eRun`，直接 `updateE2eRunStatus('running')`
- 不写多行注释块（`/* ... */`）
- 所有 import 用 `.js` 后缀（NodeNext 模块）
