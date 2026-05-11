# QI Pipeline New Topology (Sub-plan B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 Sub-plan A 的新 stage types（llm_author / llm_review / human_gate / git_commit_push / cleanup / end）重写 `buildQuickImplGraph()`，把当前 15 节点拓扑替换为 22 节点拓扑，同时修 Task 6 留下的 2 个 TODO。

**Architecture:** 改写 `src/quick-impl/bootstrap.ts:buildQuickImplGraph()` 的 nodes 数组和 edges 数组，把 `skill_with_approval` / `skill_with_review` 复合节点拆成 author + ai_review + human_gate + commit_push 原子节点；把 `final_approval` 的 skill=null hack 改为 human_gate；把 `mr_create_skip` 的 switch 自环 hack 改为 cleanup → end。版本号从 11 bump 到 12，bootstrap 自动在 server 启动时把新 graph 写进 `test_pipelines.graph`。In-flight runs 用启动时的 graph 快照，不被破坏。

**Tech Stack:** TypeScript ES2022 + NodeNext + LangGraph + PostgreSQL + Vitest

**Spec:** [docs/superpowers/specs/2026-05-11-qi-pipeline-topology-design.md](../specs/2026-05-11-qi-pipeline-topology-design.md)
**Sub-plan A:** [docs/superpowers/plans/2026-05-11-qi-pipeline-stage-types-sub-plan-a.md](2026-05-11-qi-pipeline-stage-types-sub-plan-a.md)

**Out of Scope（本 plan 不涉及）：**
- E2E 节点 4 拆（保持 `qi_e2e_runner` 占位）
- mr_create 幂等改造（→ Sub-plan C）
- branch_init 占位 push 增强（→ Sub-plan D）
- 节点级 retry admin API（→ Sub-plan E）
- Requirement.status 枚举细化（多个节点共享 status，UI 看到的是 phase 级而非 node 级，下个 sub-plan 议）

---

## File Structure

**Create:**
- `src/__tests__/integration/qi-pipeline-bootstrap-v12.test.ts` — 新 bootstrap 后 graph 编译可跑测试

**Modify:**
- `src/pipeline/graph-runner.ts` — `dispatchInterrupt` 的 `QI_APPROVAL_INTERRUPT` 分支加 `scheduleTimeout`（Task 1）
- `src/pipeline/qi-approval-manager.ts` — `ApprovalKind` union 加 `'human_gate'`，`kindLabel` 加分支（Task 2）
- `src/pipeline/graph-builder.ts` — `buildHumanGateNode` 允许 `params.approvalKind` 覆盖（Task 2）
- `src/quick-impl/bootstrap.ts` — `buildQuickImplGraph()` 重写 + `QUICK_IMPL_TEMPLATE_VERSION` 从 11 → 12（Task 3, 4, 5）

**单元测试 pattern 参考：** [src/__tests__/unit/node-types/](../../../src/__tests__/unit/node-types/) + [src/__tests__/integration/new-stage-types-smoke.test.ts](../../../src/__tests__/integration/new-stage-types-smoke.test.ts)

---

## Task 1: human_gate timeout 实际接 scheduleTimeout

修 Task 6 留下的 TODO #1：当前 `dispatchInterrupt` 对 `QI_APPROVAL_INTERRUPT` 类型**没**调 `scheduleTimeout`（对比 `APPROVAL_INTERRUPT` / `WEBHOOK_INTERRUPT` 都调了），导致 `human_gate.params.timeoutSeconds` / `onTimeout` 配置不生效。

**Files:**
- Modify: `src/pipeline/graph-runner.ts` — 找 `dispatchInterrupt` 函数，加 `QI_APPROVAL_INTERRUPT` 的 timeout 分支
- Create: `src/__tests__/integration/human-gate-timeout.test.ts`

### Steps

- [ ] **Step 1.1: 探查 dispatchInterrupt 现状**

```bash
grep -n "dispatchInterrupt\|scheduleTimeout\|QI_APPROVAL_INTERRUPT\|APPROVAL_INTERRUPT\|WEBHOOK_INTERRUPT" src/pipeline/graph-runner.ts | head -30
```

读 `dispatchInterrupt` 函数：看 `APPROVAL_INTERRUPT` 分支怎么调 `scheduleTimeout`（参数：runId, waiterId, timeoutSeconds, onTimeout）。

- [ ] **Step 1.2: 写失败测试**

Create `src/__tests__/integration/human-gate-timeout.test.ts`：

```typescript
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { resetTestDb, releaseTestDb } from '../helpers/db.js'

describe('human_gate timeout wiring', () => {
  beforeAll(async () => {
    await resetTestDb()
  })

  afterAll(async () => {
    await releaseTestDb()
  })

  it('schedules timeout when human_gate creates QI_APPROVAL_INTERRUPT', async () => {
    // 构造一个最小 graph：human_gate 节点
    // 跑 startRun → graph 应该 interrupt
    // 检查 DB scheduled_timeouts / timeouts 表是否有该 waiter 的 timeout 记录
    //
    // 关键 assert: timeout 表里有一条 record，{
    //   runId,
    //   waiterId,
    //   firesAt: now + timeoutSeconds * 1000,
    //   onTimeout: 'approve' or 'reject' (按 config)
    // }

    // 实际实现：grep 现有 timeout 表 + scheduleTimeout 调用看怎么 assert
    // 留这个测试 stub，让实现者 fill in 具体 assertion
    expect.fail('TODO: write timeout assertion based on real scheduleTimeout API surface')
  })
})
```

**注意：** 这个测试用 `expect.fail` 占位，让实现者在 Step 1.4 实现时根据实际的 timeout 表 schema 和 API surface 写真正的 assertion。这是为了避免在 plan 里猜 API。

- [ ] **Step 1.3: Run — expect FAIL（占位 assertion）**

```bash
npx vitest run src/__tests__/integration/human-gate-timeout.test.ts
```

- [ ] **Step 1.4: 实现 scheduleTimeout wiring**

在 `src/pipeline/graph-runner.ts` 的 `dispatchInterrupt` 函数中，找到 `QI_APPROVAL_INTERRUPT` 分支（grep `QI_APPROVAL_INTERRUPT` 看现有代码），在 `sendQiApprovalCard` 调用之后、return 之前，加：

```typescript
// QI_APPROVAL_INTERRUPT 分支
if (data.type === QI_APPROVAL_INTERRUPT) {
  const qiData = data as QiApprovalInterruptData
  await sendQiApprovalCard(qiData)

  // 新增：human_gate 节点需要 scheduleTimeout
  // qiData.contextSummary 应该含 timeoutSeconds / onTimeout（在 buildHumanGateNode 里塞进去）
  const timeoutSeconds = Number(qiData.contextSummary?.timeoutSeconds ?? 0)
  const onTimeout = String(qiData.contextSummary?.onTimeout ?? 'reject') as 'approve' | 'reject'
  if (timeoutSeconds > 0) {
    await scheduleTimeout({
      runId: ctx.runId,
      nodeId: qiData.nodeId,
      waiterId: qiData.waiterId,
      firesAt: new Date(Date.now() + timeoutSeconds * 1000),
      payload: { kind: 'qi_human_gate_timeout', onTimeout, waiterId: qiData.waiterId },
    })
  }
  return
}
```

**重要：** 这是 sketch，实际代码以 `scheduleTimeout` API surface 和 `QiApprovalInterruptData` 结构为准。
- grep `scheduleTimeout` 看真实 signature
- grep `QiApprovalInterruptData` 看 contextSummary 结构

同步改 `buildHumanGateNode`（`src/pipeline/graph-builder.ts`），把 `timeoutSeconds` / `onTimeout` 塞进 `contextSummary`：

```typescript
// buildHumanGateNode 里 createWaiter 之前的 contextSummary 构造，加 timeoutSeconds + onTimeout
const contextSummary = {
  source,
  artifact,
  aiReview,
  aiAttempts,
  timeoutSeconds,    // 新增
  onTimeout,         // 新增
}
```

- [ ] **Step 1.5: 处理 timeout 触发回调（resume graph with timeout decision）**

scheduleTimeout 触发时需要：
1. 校验 waiter 还在 pending（未被人审 claim）
2. 按 `onTimeout` 配置自动 claim waiter as `approved` 或 `rejected`，humanNote 写 "timeout auto-decided"
3. 调 `resumeFromQiApproval(waiterId, claimedWaiter)` 让 graph 继续

grep `handleTimeout\|timeoutCallback\|processScheduledTimeout` 看现有 timeout 处理流程。在合适的 handler 里加 `kind === 'qi_human_gate_timeout'` 分支：

```typescript
// 处理 qi_human_gate_timeout
if (payload?.kind === 'qi_human_gate_timeout') {
  const waiter = await getActiveWaiterById(payload.waiterId)
  if (!waiter || waiter.decision) {
    return  // 已被人审 claim，timeout 无效
  }
  const decision = payload.onTimeout === 'approve' ? 'approved' : 'rejected'
  const claimedWaiter = await claimWaiterByTimeout({
    waiterId: payload.waiterId,
    decision,
    humanNote: `timeout (${payload.onTimeout}) auto-decided`,
  })
  if (claimedWaiter) {
    await resumeFromQiApproval(payload.waiterId, claimedWaiter)
  }
  return
}
```

**实现者注：** `claimWaiterByTimeout` 可能需要新增（参考现有 `claimWaiter` 实现）。如果现有 timeout handler 框架不存在 / 太复杂，BLOCKED 报告，可能要简化为 polling reconciler。

- [ ] **Step 1.6: 完善测试 assertion + 跑 PASS**

把 `expect.fail` 替换为真实 assertion（按 Step 1.4-1.5 实际 API）。跑：
```bash
./test.sh --filter human-gate-timeout
./test.sh --typecheck
```

- [ ] **Step 1.7: 删 Task 6 留下的 TODO 注释**

grep `TODO(Sub-plan B): human_gate timeoutSeconds` 在 `src/pipeline/graph-builder.ts`，删除该注释段。

- [ ] **Step 1.8: Commit**

```bash
git add src/pipeline/graph-runner.ts src/pipeline/graph-builder.ts src/__tests__/integration/human-gate-timeout.test.ts
git commit -m "feat(qi): wire human_gate timeoutSeconds/onTimeout to scheduleTimeout

Task 6 Sub-plan A 留的 TODO #1 修复：dispatchInterrupt 对 QI_APPROVAL_INTERRUPT
现在调 scheduleTimeout；timeout 触发时按 onTimeout (approve/reject) auto-claim
waiter 并 resume graph。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: human_gate approvalKind 允许 params 覆盖

修 Task 6 留下的 TODO #2：当前 `buildHumanGateNode` 里 `createWaiter` 调用 `approvalKind: 'spec'` 硬编码，导致 plan/dev/final 阶段用 human_gate 时 IM 卡片标题都显示「Spec 评审」。

**Files:**
- Modify: `src/pipeline/qi-approval-manager.ts` — `ApprovalKind` union 加 `'human_gate'`，`kindLabel` 加分支
- Modify: `src/pipeline/graph-builder.ts` — `buildHumanGateNode` 从 `params.approvalKind` 取值

### Steps

- [ ] **Step 2.1: 探查 ApprovalKind 和 kindLabel 现状**

```bash
grep -n "ApprovalKind\b\|approvalKind\b\|kindLabel\b" src/pipeline/qi-approval-manager.ts src/pipeline/graph-builder.ts | head -20
```

读 `ApprovalKind` 的 union 定义（应该是 `'spec' | 'plan' | 'final' | 'escalation'` 之类）。
读 `sendQiApprovalCard` 怎么把 `approvalKind` 映射成 `kindLabel`（中文标签）。

- [ ] **Step 2.2: 写测试（kindLabel 按 approvalKind 变）**

Create test or extend existing `src/__tests__/unit/qi-approval-manager.test.ts`（如果存在）：

```typescript
import { describe, it, expect } from 'vitest'
// import 真实 kindLabel 函数或 sendQiApprovalCard 测试 fixture

describe('approvalKind kindLabel', () => {
  it('spec → "Spec 评审"', () => {
    // 现有行为，应该保持
  })
  it('plan → "Plan 评审"', () => {
    // 现有行为，应该保持
  })
  it('human_gate → "人工审批"（新增）', () => {
    // 新增分支
  })
  it('human_gate with source=final → "最终批准"（更精细）', () => {
    // 可选优化：如果 contextSummary.source === 'final'，标签变 "最终批准"
  })
})
```

如果 `qi-approval-manager.test.ts` 不存在，新建。

- [ ] **Step 2.3: Run — expect FAIL**

- [ ] **Step 2.4: 扩展 ApprovalKind union**

修 `src/pipeline/qi-approval-manager.ts`：

```typescript
// 找到 ApprovalKind 定义
export type ApprovalKind = 'spec' | 'plan' | 'final' | 'escalation' | 'human_gate'
```

修 `kindLabel`（grep 找它）：

```typescript
function kindLabel(kind: ApprovalKind, contextSummary?: Record<string, unknown>): string {
  switch (kind) {
    case 'spec':       return 'Spec 评审'
    case 'plan':       return 'Plan 评审'
    case 'final':      return '最终批准'
    case 'escalation': return '升级审批'
    case 'human_gate': {
      // 按 source 区分子标签
      const source = String((contextSummary?.source as string) ?? '')
      if (source === 'ai_pass')       return '人工审核'
      if (source === 'ai_escalation') return '人工裁决（AI 多轮未过）'
      if (source === 'final')         return '最终批准'
      return '人工审批'
    }
  }
}
```

**注意：** 实际函数签名以 grep 出来的为准。如果当前签名只接收 `kind` 不接 `contextSummary`，需要扩展签名 + 改所有调用方传入 contextSummary。

- [ ] **Step 2.5: 修 buildHumanGateNode 从 params 取 approvalKind**

修 `src/pipeline/graph-builder.ts` 的 `buildHumanGateNode`，找 `createWaiter({ approvalKind: 'spec', ... })` 这一段，改为：

```typescript
const approvalKind = String(params.approvalKind ?? 'human_gate') as ApprovalKind
// ...
await createWaiter({
  ...,
  approvalKind,   // 从 params 取，默认 'human_gate'
  ...,
})
```

- [ ] **Step 2.6: Run tests — expect PASS**

```bash
./test.sh --filter qi-approval-manager
./test.sh --filter human-gate
./test.sh --typecheck
```

- [ ] **Step 2.7: 删 Task 6 留下的 TODO 注释**

grep `TODO(Sub-plan B): approvalKind='spec'` 在 graph-builder.ts，删该注释段。

- [ ] **Step 2.8: Commit**

```bash
git add src/pipeline/qi-approval-manager.ts src/pipeline/graph-builder.ts src/__tests__/unit/qi-approval-manager.test.ts
git commit -m "feat(qi): human_gate approvalKind 可通过 params 覆盖

Task 6 Sub-plan A 留的 TODO #2 修复：ApprovalKind union 加 'human_gate'；
kindLabel 按 contextSummary.source 区分子标签（ai_pass/ai_escalation/final）；
buildHumanGateNode 从 params.approvalKind 读取，默认 'human_gate'。
Pipeline 定义可显式传 'spec'/'plan'/'final' 覆盖卡片标题。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: 重写 `buildQuickImplGraph` — Nodes 数组

把现有 15 节点的 `nodes` 数组替换为新的 22 节点。**核心改动：** 把 4 个复合节点 / hack 替换成 17 个原子节点：

| 旧节点 | 替换为 |
|---|---|
| `spec_review_loop` (skill_with_approval) | `spec_author` + `spec_ai_review` + `spec_human_gate` + `spec_commit_push` |
| `plan_review_loop` (skill_with_review) + `plan_human_escalation` (skill_with_approval) | `plan_author` + `plan_ai_review` + `plan_human_gate` + `plan_commit_push` |
| `dev_with_review_loop` (skill_with_review) | `dev_author` + `dev_ai_review` + `dev_human_gate` + `dev_push` |
| `dev_loop_for_e2e_fix` (skill_with_review) | `dev_fix_author` + `dev_fix_ai_review` |
| `final_approval` (skill_with_approval + skill=null) | `final_approval` (human_gate, mode=required) |
| `mr_create_skip` (switch 自环) | `cleanup` + `done` (end) |

**保留不动：** `init_branch`、`qi_e2e_runner`、`e2e_router`、`e2e_im_intervention`、`e2e_intervention_router`、`e2e_sandbox_intervention`、`sandbox_intervention_router`、`mr_create`。

**Files:**
- Modify: `src/quick-impl/bootstrap.ts:buildQuickImplGraph()`

### Steps

- [ ] **Step 3.1: 备份当前 buildQuickImplGraph**

读完整当前实现（约 L43-L420）：

```bash
sed -n '43,425p' src/quick-impl/bootstrap.ts
```

写一份注释保留旧拓扑作为对照（commit 进 git 历史就行，不用单独文件）。

- [ ] **Step 3.2: 改 init_branch (保持，但更新 status 切换字段)**

`init_branch` 节点保留不动。当前 status 切换是 `spec_review`，新拓扑里 spec_review 不存在了，但旧 `RequirementStatus` 枚举里有 `spec_review`，所以保持 `statusOnSuccess: 'spec_review'` 字面值。

**实际：** 这一步不改动 init_branch，跳过此 step。

- [ ] **Step 3.3: 添加 spec 阶段 4 节点（替代 spec_review_loop）**

在 `nodes` 数组的 `init_branch` 之后，**删除** `spec_review_loop`，**插入** 4 个新节点：

```typescript
// Spec 阶段：author → ai_review → human_gate (required) → commit_push
makeNode('spec_author', {
  name: 'Spec Author',
  stageType: 'llm_author',
  onFailure: 'continue',
  params: {
    requirementId: '{{triggerParams.requirementId}}',
    skill: 'quick-impl-artifact-author',
    role: 'spec-author',
    worktreePath: '{{steps.init_branch.output.worktreePath}}',
    branch: '{{steps.init_branch.output.branch}}',
    baseBranch: '{{triggerParams.baseBranch}}',
    artifactPath: 'docs/specs/qi-{{triggerParams.requirementId}}.md',
    maxTurns: 100,
    timeoutMs: 1800000,
    statusOnSuccess: 'spec_review',
    inputs: {
      rawInput: '{{triggerParams.rawInput}}',
    },
  },
} as any),

makeNode('spec_ai_review', {
  name: 'Spec AI Review',
  stageType: 'llm_review',
  onFailure: 'continue',
  params: {
    requirementId: '{{triggerParams.requirementId}}',
    skill: 'quick-impl-artifact-author',
    role: 'spec-reviewer',
    worktreePath: '{{steps.init_branch.output.worktreePath}}',
    branch: '{{steps.init_branch.output.branch}}',
    baseBranch: '{{triggerParams.baseBranch}}',
    artifactPath: 'docs/specs/qi-{{triggerParams.requirementId}}.md',
    maxTurns: 30,
    timeoutMs: 600000,
  },
} as any),

makeNode('spec_human_gate', {
  name: 'Spec Human Gate',
  stageType: 'human_gate',
  onFailure: 'stop',
  params: {
    requirementId: '{{triggerParams.requirementId}}',
    mode: 'required',  // spec 阶段总是要人审
    timeoutSeconds: 86400,
    onTimeout: 'reject',
    approvalKind: 'spec',  // IM 卡片显示"Spec 评审"
    approverIds: '{{vars.qiApproverIds}}',
    source: 'ai_pass',  // 边路由决定 source（默认 ai_pass；AI fail 时 graph 边可改 'ai_escalation'）
    artifact: '{{steps.spec_author.output.skillOutput}}',
    aiReview: '{{steps.spec_ai_review.output}}',
  },
} as any),

makeNode('spec_commit_push', {
  name: 'Spec Commit & Push',
  stageType: 'git_commit_push',
  onFailure: 'stop',
  params: {
    worktreePath: '{{steps.init_branch.output.worktreePath}}',
    branch: '{{steps.init_branch.output.branch}}',
    artifactPaths: ['docs/specs/qi-{{triggerParams.requirementId}}.md'],
    commitMessage: 'docs(qi-{{triggerParams.requirementId}}): spec — {{triggerParams.title}}',
  },
} as any),
```

**注意 (status 字段)：** `statusOnSuccess` 只在 author 节点设置（status 一次切到 `spec_review`），后续 review/gate/push 不切。

**注意 (source 字段)：** 当前是默认 `'ai_pass'`，AI review fail 时由 graph 边的 condition 路由到同一个 `spec_human_gate` 但希望传 `source='ai_escalation'`。当前 buildHumanGateNode 读 `params.source`，模板渲染时是固定字符串。**简化方案：** 用条件边把 ai_pass 路径直接到 `spec_human_gate`，AI fail 路径先到一个 `spec_router` switch 节点（target 仍是 `spec_human_gate`，但条件里可以 inject 不同的 inputs）。这个复杂度先不上，**Sub-plan B 用单一 source='ai_pass' 跑通**，escalation 逻辑下个 patch 议。
- 实现者注：实际上 spec_human_gate 总走 `source='ai_pass'` 即可（mode=required 时无论 AI pass/fail 都走人审）。后续 escalation 上下文优化作为 Sub-plan B.1 议题。

- [ ] **Step 3.4: 添加 plan 阶段 4 节点（替代 plan_review_loop + plan_human_escalation）**

**删除** `plan_review_loop` 和 `plan_human_escalation`，**插入** 4 个新节点：

```typescript
makeNode('plan_author', {
  name: 'Plan Author',
  stageType: 'llm_author',
  onFailure: 'continue',
  params: {
    requirementId: '{{triggerParams.requirementId}}',
    skill: 'quick-impl-artifact-author',
    role: 'plan-decomposer',
    worktreePath: '{{steps.init_branch.output.worktreePath}}',
    branch: '{{steps.init_branch.output.branch}}',
    baseBranch: '{{triggerParams.baseBranch}}',
    artifactPath: 'docs/plans/qi-{{triggerParams.requirementId}}.md',
    maxTurns: 100,
    timeoutMs: 1800000,
    statusOnSuccess: 'planning',
    inputs: {
      spec: '{{steps.spec_author.output.skillOutput}}',
      specPath: '{{steps.spec_author.output.artifactPath}}',
      rawInput: '{{triggerParams.rawInput}}',
    },
  },
} as any),

makeNode('plan_ai_review', {
  name: 'Plan AI Review',
  stageType: 'llm_review',
  onFailure: 'continue',
  params: {
    requirementId: '{{triggerParams.requirementId}}',
    skill: 'quick-impl-artifact-author',
    role: 'plan-reviewer',
    worktreePath: '{{steps.init_branch.output.worktreePath}}',
    branch: '{{steps.init_branch.output.branch}}',
    baseBranch: '{{triggerParams.baseBranch}}',
    artifactPath: 'docs/plans/qi-{{triggerParams.requirementId}}.md',
    maxTurns: 30,
    timeoutMs: 600000,
    inputs: {
      spec: '{{steps.spec_author.output.skillOutput}}',
    },
  },
} as any),

makeNode('plan_human_gate', {
  name: 'Plan Human Gate',
  stageType: 'human_gate',
  onFailure: 'stop',
  params: {
    requirementId: '{{triggerParams.requirementId}}',
    mode: 'on_fail',  // AI 通过则跳过；AI N-fail 才走人审
    timeoutSeconds: 172800,  // 48h（escalation 比常规 24h 长）
    onTimeout: 'reject',
    approvalKind: 'plan',
    approverIds: '{{vars.qiApproverIds}}',
    source: 'ai_escalation',  // 走到这里必然是 ai_escalation 路径
    artifact: '{{steps.plan_author.output.skillOutput}}',
    aiReview: '{{steps.plan_ai_review.output}}',
    aiAttempts: 3,
  },
} as any),

makeNode('plan_commit_push', {
  name: 'Plan Commit & Push',
  stageType: 'git_commit_push',
  onFailure: 'stop',
  params: {
    worktreePath: '{{steps.init_branch.output.worktreePath}}',
    branch: '{{steps.init_branch.output.branch}}',
    artifactPaths: ['docs/plans/qi-{{triggerParams.requirementId}}.md'],
    commitMessage: 'docs(qi-{{triggerParams.requirementId}}): plan',
  },
} as any),
```

**关键差异 vs spec phase：**
- plan_human_gate `mode: 'on_fail'`（不是 required，AI 通过则边路由短路绕过）
- timeoutSeconds=172800 (48h)，对应 escalation 默认
- source='ai_escalation'（走到这一节点意味着 AI N-fail）

- [ ] **Step 3.5: 添加 dev 阶段 4 节点（替代 dev_with_review_loop）**

**删除** `dev_with_review_loop`，**插入** 4 个新节点：

```typescript
makeNode('dev_author', {
  name: 'Dev Author',
  stageType: 'llm_author',
  onFailure: 'continue',
  params: {
    requirementId: '{{triggerParams.requirementId}}',
    skill: 'quick-impl-artifact-author',
    role: 'dev-loop',
    worktreePath: '{{steps.init_branch.output.worktreePath}}',
    branch: '{{steps.init_branch.output.branch}}',
    baseBranch: '{{triggerParams.baseBranch}}',
    artifactPath: '{{steps.init_branch.output.worktreePath}}',  // dev 写多文件，artifactPath 是整个 worktree
    maxTurns: 200,
    timeoutMs: 3600000,  // 1h
    statusOnSuccess: 'developing',
    inputs: {
      spec: '{{steps.spec_author.output.skillOutput}}',
      plan: '{{steps.plan_author.output.skillOutput}}',
      planPath: '{{steps.plan_author.output.artifactPath}}',
      planTasks: '{{steps.plan_author.output.skillOutput.tasks}}',
      requirementId: '{{triggerParams.requirementId}}',
    },
  },
} as any),

makeNode('dev_ai_review', {
  name: 'Dev AI Review',
  stageType: 'llm_review',
  onFailure: 'continue',
  params: {
    requirementId: '{{triggerParams.requirementId}}',
    skill: 'quick-impl-artifact-author',
    role: 'code-quality-reviewer',
    worktreePath: '{{steps.init_branch.output.worktreePath}}',
    branch: '{{steps.init_branch.output.branch}}',
    baseBranch: '{{triggerParams.baseBranch}}',
    artifactPath: '{{steps.init_branch.output.worktreePath}}',
    maxTurns: 30,
    timeoutMs: 600000,
    inputs: {
      spec: '{{steps.spec_author.output.skillOutput}}',
      plan: '{{steps.plan_author.output.skillOutput}}',
      tasksDone: '{{steps.dev_author.output.skillOutput.tasksDone}}',
    },
  },
} as any),

makeNode('dev_human_gate', {
  name: 'Dev Human Gate',
  stageType: 'human_gate',
  onFailure: 'stop',
  params: {
    requirementId: '{{triggerParams.requirementId}}',
    mode: 'on_fail',
    timeoutSeconds: 172800,
    onTimeout: 'reject',
    approvalKind: 'plan',  // 复用 plan 标签（无 'dev' 特定标签）— 或扩 ApprovalKind union（看 Task 2 实现）
    approverIds: '{{vars.qiApproverIds}}',
    source: 'ai_escalation',
    artifact: '{{steps.dev_author.output.skillOutput}}',
    aiReview: '{{steps.dev_ai_review.output}}',
    aiAttempts: 3,
  },
} as any),

makeNode('dev_push', {
  name: 'Dev Push',
  stageType: 'git_commit_push',
  onFailure: 'stop',
  params: {
    worktreePath: '{{steps.init_branch.output.worktreePath}}',
    branch: '{{steps.init_branch.output.branch}}',
    pushOnly: true,  // dev_author 内部按任务 commit，dev_push 节点只 push
    statusOnSuccess: 'testing',
  },
} as any),
```

- [ ] **Step 3.6: 添加 dev_fix 节点（替代 dev_loop_for_e2e_fix）**

**删除** `dev_loop_for_e2e_fix`，**插入** 2 个新节点（无 human gate，e2e 失败的修复迭代速度优先）：

```typescript
makeNode('dev_fix_author', {
  name: 'Dev Fix Author',
  stageType: 'llm_author',
  onFailure: 'stop',
  params: {
    requirementId: '{{triggerParams.requirementId}}',
    skill: 'quick-impl-artifact-author',
    role: 'dev-loop',
    worktreePath: '{{steps.init_branch.output.worktreePath}}',
    branch: '{{steps.init_branch.output.branch}}',
    baseBranch: '{{triggerParams.baseBranch}}',
    artifactPath: '{{steps.init_branch.output.worktreePath}}',
    maxTurns: 120,
    timeoutMs: 1800000,
    // 不切 status（仍是 'testing'）
    inputs: {
      spec: '{{steps.spec_author.output.skillOutput}}',
      plan: '{{steps.plan_author.output.skillOutput}}',
      planPath: '{{steps.plan_author.output.artifactPath}}',
      planTasks: '{{steps.plan_author.output.skillOutput.tasks}}',
      failureReport: '{{steps.qi_e2e_runner.output.failureReport}}',
      humanNote: '{{steps.e2e_im_intervention.output.humanNote}}',
      attempt: '{{steps.qi_e2e_runner.output.attempt}}',
      mode: 'e2e_fix',  // 区别于首次 dev_author，role prompt 可以分支
    },
  },
} as any),

makeNode('dev_fix_ai_review', {
  name: 'Dev Fix AI Review',
  stageType: 'llm_review',
  onFailure: 'stop',
  params: {
    requirementId: '{{triggerParams.requirementId}}',
    skill: 'quick-impl-artifact-author',
    role: 'code-quality-reviewer',
    worktreePath: '{{steps.init_branch.output.worktreePath}}',
    branch: '{{steps.init_branch.output.branch}}',
    baseBranch: '{{triggerParams.baseBranch}}',
    artifactPath: '{{steps.init_branch.output.worktreePath}}',
    maxTurns: 20,
    timeoutMs: 300000,
    inputs: {
      failureReport: '{{steps.qi_e2e_runner.output.failureReport}}',
      mode: 'e2e_fix',
    },
  },
} as any),
```

- [ ] **Step 3.7: qi_e2e_runner / e2e_router / e2e_im_intervention / e2e_sandbox_intervention 保持原样**

这一组 6 个节点（qi_e2e_runner, e2e_router, e2e_im_intervention, e2e_intervention_router, e2e_sandbox_intervention, sandbox_intervention_router）**完全不动**——Sub-plan B 不处理 E2E 拆分。

但要注意 `e2e_intervention_router` 的 switch case：当前 fix 路径 target 是 `dev_loop_for_e2e_fix`，要改为 `dev_fix_author`。grep 找 `dev_loop_for_e2e_fix` 在 bootstrap.ts 里所有出现的地方，全替换为 `dev_fix_author`（注意：是节点 ID，不是 stageType）。

**实际：** 这是 edges 改动（Task 4），这里 step 提一下是因为路由表达式里也有节点名引用。

- [ ] **Step 3.8: 替换 final_approval（hack 改 human_gate）**

**修改** `final_approval` 节点（不删，改 stageType + params）：

```typescript
makeNode('final_approval', {
  name: 'Final Approval',
  stageType: 'human_gate',  // ← 由 skill_with_approval (skill=null hack) 改为 human_gate
  onFailure: 'stop',
  params: {
    requirementId: '{{triggerParams.requirementId}}',
    mode: 'required',
    timeoutSeconds: 86400,
    onTimeout: 'reject',
    approvalKind: 'final',
    approverIds: '{{vars.qiApproverIds}}',
    source: 'final',
    statusOnSuccess: 'mr_pending',
    artifact: {
      spec: '{{steps.spec_author.output.skillOutput}}',
      plan: '{{steps.plan_author.output.skillOutput}}',
      devTasksDone: '{{steps.dev_author.output.skillOutput.tasksDone}}',
      e2eResult: '{{steps.qi_e2e_runner.output.result}}',
      e2eAttempt: '{{steps.qi_e2e_runner.output.attempt}}',
    },
  },
} as any),
```

- [ ] **Step 3.9: 添加 cleanup + done 节点（替代 mr_create_skip）**

**删除** `mr_create_skip` 节点，**插入**：

```typescript
makeNode('cleanup', {
  name: 'Cleanup',
  stageType: 'cleanup',
  onFailure: 'stop',
  params: {
    targets: [
      // worktree / bare_repo 留给运维清理；本节点暂时只 noop，等 Sub-plan C 接入远端 branch / draft MR
      // 实际 abort 路径用，cleanup 一些可清理资源
      { kind: 'worktree', path: '{{steps.init_branch.output.worktreePath}}' },
      { kind: 'bare_repo', path: '{{steps.init_branch.output.bareRepoPath}}' },
    ],
    statusOnSuccess: 'aborted',
  },
} as any),

makeNode('done', {
  name: 'Done',
  stageType: 'end',
  onFailure: 'stop',
  params: {},
} as any),
```

- [ ] **Step 3.10: mr_create 保持，但调输入字段**

`mr_create` 节点保持，但 `params.inputs` 里读 spec/plan 的字段从旧 ID（spec_review_loop / plan_review_loop）改为新 ID（spec_author / plan_author）：

```typescript
makeNode('mr_create', {
  name: 'Create MR',
  stageType: 'mr_create',
  onFailure: 'stop',
  params: {
    requirementId: '{{triggerParams.requirementId}}',
    titleTemplate: 'Draft: [quick-impl] {{triggerParams.title}}',
    labels: ['quick-impl'],
    removeSourceBranchAfterMerge: true,
    squashCommits: false,
    draft: true,
    statusOnSuccess: 'mr_open',
    inputs: {
      spec: '{{steps.spec_author.output.skillOutput}}',
      plan: '{{steps.plan_author.output.skillOutput}}',
      devReview: '{{steps.dev_ai_review.output}}',
      tasksDone: '{{steps.dev_author.output.skillOutput.tasksDone}}',
    },
  },
} as any),
```

- [ ] **Step 3.11: 跑 typecheck + bootstrap 单测**

```bash
./test.sh --typecheck
./test.sh --filter bootstrap  # 如果有 bootstrap 测试
```

**注意：** 这一步**只验证 nodes 数组 typecheck 通过**，edges 还没改，bootstrap 调用 `buildQuickImplGraph()` 会因为 edges 引用不存在的节点 ID 失败。这是预期的，Task 4 会修。

如果 typecheck 也挂（因为 `makeNode` 类型 strict），先记录 error，可能需要 inline `as any` cast。

- [ ] **Step 3.12: Commit Task 3（仅 nodes 改动）**

```bash
git add src/quick-impl/bootstrap.ts
git commit -m "feat(qi): 重写 buildQuickImplGraph nodes — spec/plan/dev/fix 阶段拆原子节点

Sub-plan B Task 3：把 4 个 skill_with_review/skill_with_approval 复合节点 + 2 个 hack
替换为 17 个原子节点：
- spec phase: spec_author + spec_ai_review + spec_human_gate (required) + spec_commit_push
- plan phase: plan_author + plan_ai_review + plan_human_gate (on_fail) + plan_commit_push
- dev phase: dev_author + dev_ai_review + dev_human_gate (on_fail) + dev_push (pushOnly)
- dev_fix phase: dev_fix_author + dev_fix_ai_review (无 human_gate)
- final: final_approval (human_gate, 替代 skill=null hack)
- end: cleanup + done (替代 mr_create_skip switch 自环)

Edges 留给下一个 commit。Bootstrap 版本号未 bump，新拓扑暂不生效。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: 重写 `buildQuickImplGraph` — Edges 数组

更新 edges 数组，把所有引用旧节点 ID 的边改为新节点 ID，加入新节点之间的 wiring。

**Files:**
- Modify: `src/quick-impl/bootstrap.ts:buildQuickImplGraph()` — edges 部分

### Steps

- [ ] **Step 4.1: 删除所有旧 edges**

找到 edges 数组（约 L357-L420），把所有 push 都删掉，重新写：

- [ ] **Step 4.2: 写新 edges**

```typescript
const edges: PipelineEdge[] = []

// === Spec phase ===
edges.push({ id: 'init_branch__spec_author', source: 'init_branch', target: 'spec_author' })
edges.push({ id: 'spec_author__spec_ai_review', source: 'spec_author', target: 'spec_ai_review' })
edges.push({ id: 'spec_ai_review__spec_human_gate', source: 'spec_ai_review', target: 'spec_human_gate' })
// spec_human_gate approve → commit_push（reject → 回 spec_author 由 graph builder onFailure 边表达，
// 但 human_gate.onFailure=stop，所以 reject 走 default END 路径）
// 简化：reject 直接 → cleanup（用户体验是 abort）
edges.push({ id: 'spec_human_gate__spec_commit_push', source: 'spec_human_gate', target: 'spec_commit_push', condition: { kind: 'onSuccess' } })
edges.push({ id: 'spec_human_gate__cleanup_reject', source: 'spec_human_gate', target: 'cleanup', condition: { kind: 'onFailure' } })
edges.push({ id: 'spec_commit_push__plan_author', source: 'spec_commit_push', target: 'plan_author' })

// === Plan phase ===
edges.push({ id: 'plan_author__plan_ai_review', source: 'plan_author', target: 'plan_ai_review' })
// AI pass → 跳过 human_gate 直接 commit_push（mode=on_fail 短路）
edges.push({ id: 'plan_ai_review__plan_commit_push_pass', source: 'plan_ai_review', target: 'plan_commit_push', condition: { kind: 'onSuccess' } })
// AI fail → human_gate 兜底
edges.push({ id: 'plan_ai_review__plan_human_gate', source: 'plan_ai_review', target: 'plan_human_gate', condition: { kind: 'onFailure' } })
edges.push({ id: 'plan_human_gate__plan_commit_push', source: 'plan_human_gate', target: 'plan_commit_push', condition: { kind: 'onSuccess' } })
edges.push({ id: 'plan_human_gate__cleanup_reject', source: 'plan_human_gate', target: 'cleanup', condition: { kind: 'onFailure' } })
edges.push({ id: 'plan_commit_push__dev_author', source: 'plan_commit_push', target: 'dev_author' })

// === Dev phase ===
edges.push({ id: 'dev_author__dev_ai_review', source: 'dev_author', target: 'dev_ai_review' })
edges.push({ id: 'dev_ai_review__dev_push_pass', source: 'dev_ai_review', target: 'dev_push', condition: { kind: 'onSuccess' } })
edges.push({ id: 'dev_ai_review__dev_human_gate', source: 'dev_ai_review', target: 'dev_human_gate', condition: { kind: 'onFailure' } })
edges.push({ id: 'dev_human_gate__dev_push', source: 'dev_human_gate', target: 'dev_push', condition: { kind: 'onSuccess' } })
edges.push({ id: 'dev_human_gate__cleanup_reject', source: 'dev_human_gate', target: 'cleanup', condition: { kind: 'onFailure' } })
edges.push({ id: 'dev_push__qi_e2e_runner', source: 'dev_push', target: 'qi_e2e_runner' })

// === E2E phase (unchanged from old; nodes still there) ===
edges.push({ id: 'qi_e2e_runner__e2e_router', source: 'qi_e2e_runner', target: 'e2e_router' })
// e2e_router → 4 个 case + default 由 switch 节点 params.cases 处理
for (const target of ['final_approval', 'e2e_sandbox_intervention', 'dev_fix_author', 'e2e_im_intervention']) {
  edges.push({ id: `e2e_router__${target}`, source: 'e2e_router', target })
}

// E2E IM intervention
edges.push({ id: 'e2e_im_intervention__e2e_intervention_router', source: 'e2e_im_intervention', target: 'e2e_intervention_router' })
for (const target of ['final_approval', 'dev_fix_author', 'cleanup']) {
  edges.push({ id: `e2e_intervention_router__${target}`, source: 'e2e_intervention_router', target })
}

// Sandbox intervention
edges.push({ id: 'e2e_sandbox_intervention__sandbox_intervention_router', source: 'e2e_sandbox_intervention', target: 'sandbox_intervention_router' })
for (const target of ['qi_e2e_runner', 'cleanup']) {
  edges.push({ id: `sandbox_intervention_router__${target}`, source: 'sandbox_intervention_router', target })
}

// === dev_fix loop ===
edges.push({ id: 'dev_fix_author__dev_fix_ai_review', source: 'dev_fix_author', target: 'dev_fix_ai_review' })
edges.push({ id: 'dev_fix_ai_review__qi_e2e_runner', source: 'dev_fix_ai_review', target: 'qi_e2e_runner' })

// === Final ===
edges.push({ id: 'final_approval__mr_create', source: 'final_approval', target: 'mr_create', condition: { kind: 'onSuccess' } })
edges.push({ id: 'final_approval__cleanup_reject', source: 'final_approval', target: 'cleanup', condition: { kind: 'onFailure' } })
edges.push({ id: 'mr_create__done', source: 'mr_create', target: 'done' })

// === Cleanup + done ===
edges.push({ id: 'cleanup__done', source: 'cleanup', target: 'done' })
```

- [ ] **Step 4.3: 更新 e2e_router switch case target**

找到 `e2e_router` 节点定义（Step 3.7 提到），它的 `params.cases` 里 fix 路径 `target: 'dev_loop_for_e2e_fix'` 改为 `target: 'dev_fix_author'`。

```typescript
// e2e_router 节点 params.cases
{
  when: "steps.qi_e2e_runner.output.result == 'fail' && steps.qi_e2e_runner.output.attempt < 2",
  target: 'dev_fix_author',  // ← 改这里
},
```

同时改 `e2e_intervention_router` 节点的 switch case，fix target 也改为 `dev_fix_author`。

- [ ] **Step 4.4: Bootstrap test — 构造 graph 不抛错**

```bash
./test.sh --typecheck
```

如果 graph-builder 在编译时检测节点引用不一致（如 edges 里 target 不存在），会在 `buildGraphFromPipeline` 抛错。typecheck 通过不代表运行时通过，需 Task 5 的 bootstrap 测试覆盖。

- [ ] **Step 4.5: Commit**

```bash
git add src/quick-impl/bootstrap.ts
git commit -m "feat(qi): 重写 buildQuickImplGraph edges — 串联新拓扑节点

Sub-plan B Task 4：新 22 节点拓扑的 edges 数组：
- Spec 阶段：author → ai_review → human_gate (always) → commit_push → plan_author
- Plan 阶段：author → ai_review (pass 短路 commit / fail → human_gate) → commit_push → dev_author
- Dev 阶段：同 plan 模式（on_fail 短路）→ dev_push → qi_e2e_runner
- E2E 阶段：保留现有 router/im_intervention/sandbox_intervention 5 节点 + dev_fix_author 替代 dev_loop_for_e2e_fix
- 终态：final_approval → mr_create → done；reject 路径汇 cleanup → done

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 5: Bump QUICK_IMPL_TEMPLATE_VERSION + bootstrap 单测

让新拓扑实际写入 DB，server 启动时 bootstrap 跑一次。In-flight runs 用启动时的 graph 快照不受影响。

**Files:**
- Modify: `src/quick-impl/bootstrap.ts` — `QUICK_IMPL_TEMPLATE_VERSION` 12 → 13（或 11 → 12，看现状）
- Create: `src/__tests__/integration/qi-pipeline-bootstrap-v12.test.ts`

### Steps

- [ ] **Step 5.1: 确认当前版本号**

```bash
grep -n "QUICK_IMPL_TEMPLATE_VERSION" src/quick-impl/bootstrap.ts
```

得到当前值 N（可能是 11），新版本号 N+1。

- [ ] **Step 5.2: 写 bootstrap 集成测试**

Create `src/__tests__/integration/qi-pipeline-bootstrap-v12.test.ts`（用实际新版本号命名）：

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetTestDb } from '../helpers/db.js'
import { bootstrapQuickImpl, QUICK_IMPL_PIPELINE_NAME } from '../../quick-impl/bootstrap.js'
import { getTestPipelineByName } from '../../db/repositories/test-pipelines.js'
import { buildGraphFromPipeline } from '../../pipeline/graph-builder.js'

describe('Quick-Impl bootstrap v12 (new topology)', () => {
  beforeAll(async () => {
    await resetTestDb()
  })

  it('creates pipeline definition with new topology nodes', async () => {
    await bootstrapQuickImpl()
    const pipeline = await getTestPipelineByName(QUICK_IMPL_PIPELINE_NAME)
    expect(pipeline).toBeDefined()

    const nodeNames = pipeline!.graph!.nodes.map(n => n.name)
    // 新拓扑必含的节点
    expect(nodeNames).toContain('spec_author')
    expect(nodeNames).toContain('spec_ai_review')
    expect(nodeNames).toContain('spec_human_gate')
    expect(nodeNames).toContain('spec_commit_push')
    expect(nodeNames).toContain('plan_author')
    expect(nodeNames).toContain('plan_ai_review')
    expect(nodeNames).toContain('plan_human_gate')
    expect(nodeNames).toContain('plan_commit_push')
    expect(nodeNames).toContain('dev_author')
    expect(nodeNames).toContain('dev_ai_review')
    expect(nodeNames).toContain('dev_human_gate')
    expect(nodeNames).toContain('dev_push')
    expect(nodeNames).toContain('dev_fix_author')
    expect(nodeNames).toContain('dev_fix_ai_review')
    expect(nodeNames).toContain('final_approval')
    expect(nodeNames).toContain('cleanup')
    expect(nodeNames).toContain('done')

    // 旧节点不应出现
    expect(nodeNames).not.toContain('spec_review_loop')
    expect(nodeNames).not.toContain('plan_review_loop')
    expect(nodeNames).not.toContain('plan_human_escalation')
    expect(nodeNames).not.toContain('dev_with_review_loop')
    expect(nodeNames).not.toContain('dev_loop_for_e2e_fix')
    expect(nodeNames).not.toContain('mr_create_skip')
  })

  it('compiles into a valid LangGraph (no broken edges)', async () => {
    await bootstrapQuickImpl()
    const pipeline = await getTestPipelineByName(QUICK_IMPL_PIPELINE_NAME)

    const fakeSkillExecutor = {
      execute: async () => ({ rawOutput: '{"decision":"pass","notes":"ok"}' }),
    }

    const ctxBase = {
      runId: 9999,
      pipelineId: pipeline!.id,
      skillExecutor: fakeSkillExecutor as any,
      mcpServerPath: '/dev/null',
    }

    // buildGraphFromPipeline 不抛错（验证 edges target 都存在、stageType 都注册）
    expect(() => buildGraphFromPipeline({
      graph: pipeline!.graph!,
      stageContext: ctxBase as any,
      hooks: { onStageStart: async () => {}, onStageComplete: async () => {} } as any,
      triggerParams: {},
    })).not.toThrow()
  })
})
```

- [ ] **Step 5.3: Run — expect FAIL（current version 没 bump）**

```bash
npx vitest run src/__tests__/integration/qi-pipeline-bootstrap-v12.test.ts
```

bootstrap 不重写（版本号未 bump），DB 里还是旧 graph，新 nodeNames assertion fail。

- [ ] **Step 5.4: Bump version**

```typescript
// src/quick-impl/bootstrap.ts
const QUICK_IMPL_TEMPLATE_VERSION = 12  // ← 从 11 改为 12
```

并把版本描述更新：

```typescript
await updateTestPipeline(existing.id, {
  graph,
  description: 'Quick-Impl：22 节点新拓扑（spec/plan/dev 拆 author/ai_review/human_gate/commit_push）',
  // ...
})
```

- [ ] **Step 5.5: Run — expect PASS**

```bash
npx vitest run src/__tests__/integration/qi-pipeline-bootstrap-v12.test.ts
```

- [ ] **Step 5.6: Commit**

```bash
git add src/quick-impl/bootstrap.ts src/__tests__/integration/qi-pipeline-bootstrap-v12.test.ts
git commit -m "feat(qi): bump QUICK_IMPL_TEMPLATE_VERSION 11 → 12 — 新拓扑生效

Server 启动后 bootstrap 自动把 22 节点新拓扑写入 test_pipelines.graph。
In-flight runs 用启动时的 graph 快照不受影响，新 requirements 走新拓扑。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 6: 端到端 smoke 验证（最小路径）

不跑完整 QI 流程（需要 GitLab + IM + LLM credentials，超出 plan 范围），仅验证：
1. Bootstrap 跑通 → DB 写入新 graph
2. 调 `buildGraphFromPipeline` 编译新 graph 不报错
3. 跑测试套件 `./test.sh` 整体不回归

**Files:**
- 无新增。仅验证。

### Steps

- [ ] **Step 6.1: 跑 typecheck**

```bash
./test.sh --typecheck
```

Expected: PASS

- [ ] **Step 6.2: 跑完整测试套件**

```bash
./test.sh
```

Expected: 全 PASS，新增的 bootstrap-v12 测试通过。**Sub-plan B 任何 task 都不应破坏现有测试。** 如果有现存 QI 测试假设旧节点 ID，更新它们：

```bash
grep -rn "spec_review_loop\|plan_review_loop\|dev_with_review_loop\|dev_loop_for_e2e_fix\|mr_create_skip\|plan_human_escalation" src/__tests__/
```

逐个看，要么测试是历史性测试（保留），要么是验证拓扑结构的测试（更新为新节点 ID）。

- [ ] **Step 6.3: 手动 smoke（可选，需要环境）**

如果有 dev 环境跟 GitLab + IM 配置：
1. `pnpm migrate`（确保 schema 是 v1011+）
2. `pnpm dev` 启动后端
3. 看 server 启动日志，应该有 "Quick-Impl bootstrap: version 12 written"
4. 在 admin /requirements 页面建一个新需求 → 触发运行
5. 观察 IM 群看 spec_author 阶段卡片 + spec_human_gate IM 卡片

**如果手动跑挂了：**
- BLOCKED 报告，描述卡在哪个节点
- 不要试图修复（可能涉及 buildLlmAuthorNode / buildLlmReviewNode / buildHumanGateNode 的运行时 bug，超出 Sub-plan B 范畴）

- [ ] **Step 6.4: 更新 grep-able TODO 列表**

```bash
grep -rn "TODO(Sub-plan B)" src/
```

Task 1 + Task 2 的两个 TODO 注释应已删除（在 Step 1.7 / Step 2.7）。如果还有遗漏，删除。

- [ ] **Step 6.5: Commit（如有测试更新）**

```bash
git add src/__tests__/...
git commit -m "test(qi): 更新现有测试适配新拓扑节点 ID

Sub-plan B 完工 self-check：grep 现有测试中残留的旧节点 ID 引用，逐个更新。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Self-Review

- [ ] **Spec coverage**：spec §3 拓扑图的非 E2E 部分（16 个节点：branch_init / spec×4 / plan×4 / dev×4 / dev_fix×2 / final / mr / cleanup / done）都进 Task 3。`qi_e2e_runner` 等 E2E 节点（placeholder）保持现状。Task 6 留下的 2 个 TODO 在 Task 1+2 修。✅

- [ ] **Placeholder scan**：grep `TODO|TBD|implement later` 在本 plan 代码块。Task 3.3 注释提到的"escalation 上下文优化作为 Sub-plan B.1 议题"是 explicit 未来工作，不算 placeholder。Task 1.2 测试用 `expect.fail` 占位（必须 fill in），有 explicit 说明。其他无。

- [ ] **Type consistency**：
  - 新节点 ID 命名：`<phase>_author` / `<phase>_ai_review` / `<phase>_human_gate` / `<phase>_commit_push` 或 `<phase>_push`（dev 阶段是 dev_push pushOnly mode）— 一致 ✅
  - 跨 task 引用：Task 4 edges 引用的 ID 跟 Task 3 nodes 一致 ✅
  - approvalKind 取值：spec/plan/dev/final 都符合 Task 2 扩展后的 union ✅
  - status 字段：`statusOnSuccess` 仅在 phase 首节点（author）设置，其他不切 ✅

- [ ] **Commit message 约定**：`feat(qi): ...` 前缀，符合现仓 commit-conventions ✅

---

## Execution Handoff

Plan 写完，保存到 `docs/superpowers/plans/2026-05-11-qi-pipeline-new-topology-sub-plan-b.md`。

**风险：**
- Task 3 是单文件 ~400 行大改，TDD 颗粒度受限（写完整个 buildQuickImplGraph 才能跑 bootstrap test）。建议分 commit 但同 task。
- Task 1 的 scheduleTimeout API surface 实现者要 grep 出来，plan 里只给 sketch。如发现 timeout 框架不存在，BLOCKED escalate。
- 现有测试可能引用旧节点 ID 大面积。Task 6.2 grep 后视情况决定是 update 还是新建测试。

**执行选项：**

1. **Subagent-Driven（推荐）** — 每 task dispatch fresh subagent，task 间复审
2. **Inline 执行** — 用 executing-plans skill 当前 session 批量跑

**Which approach?**
