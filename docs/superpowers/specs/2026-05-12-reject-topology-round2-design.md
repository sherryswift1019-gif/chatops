# Reject 拓扑 + Round-2 重写机制 — Design

**Date**: 2026-05-12
**Scope**: `src/pipeline/graph-builder.ts` (buildHumanGateNode + buildLlmAuthorNode), `src/db/repositories/requirements.ts` (retry_counters helpers), `src/quick-impl/bootstrap.ts` (params on *_human_gate), `web/src/pages/RequirementsPage.tsx` (decision dropdown disable logic).

## 1. Goal

让 spec_human_gate / plan_human_gate / dev_human_gate 三个节点上的 `decision='rejected'` **真正触发对应 author 节点重跑**（带上轮 rejectReason 作为反馈），同时设置 cap=3 上限，达上限时前端禁用 reject 选项。`final_approval` reject 维持原 abort 语义（不重写）。

## 2. Why

[graph-builder.ts:2621-2629](../../../src/pipeline/graph-builder.ts#L2621-L2629) 当前实现：reject 让 stage status='failed'，然后 `onFailure: 'stop'` 直接 halt 整个 pipeline。bootstrap.ts 写的 `spec_human_gate__cleanup_reject` (onFailure edge) 走不到。skill-runner 已经支持的 `previousRound.rejectReason → feedback.md → spec-author 重写`机制完全没被 pipeline 触发。

E2E 验证（req #2 round 1 reject）暴露：reject 后出现孤儿 waiter（同 nodeId, round 硬编码 1, content 100% 等于 round 1），用户点 reject 没有任何下游效果。

## 3. Design

### 3.1 数据 schema

`requirements.retry_counters` JSONB 字段扩展（不需要 migration — JSONB 自由结构）：

```ts
retry_counters: {
  node_retry_counts: Record<string, number>      // 已有 (NODE_RETRY_CAP=3)
  reject_counts: Record<string, number>          // 新增 — *_human_gate 被 reject 的累计次数；key=human_gate nodeId
  last_reject_reasons: Record<string, string>    // 新增 — 上轮 rejectReason；key=author nodeId（用于注入 previousRound）
}
```

新 helper（[src/db/repositories/requirements.ts](../../../src/db/repositories/requirements.ts)）：

```ts
export async function getRejectCount(requirementId: number, humanGateNodeId: string): Promise<number>
export async function incrementRejectCount(args: {
  requirementId: number
  humanGateNodeId: string       // e.g. 'spec_human_gate'  
  authorNodeId: string          // e.g. 'spec_author' — last_reject_reasons key
  rejectReason: string
}): Promise<{ newCount: number }>
```

`incrementRejectCount` 用 `jsonb_set` 原子更新 reject_counts[humanGateNodeId]++ + last_reject_reasons[authorNodeId] = rejectReason。

### 3.2 `buildHumanGateNode` rejected 分支

[graph-builder.ts:2621](../../../src/pipeline/graph-builder.ts#L2621) `interrupt` 返回后增加 rejected 分支：

```ts
const resume = interrupt(interruptPayload) as QiApprovalResume
const rawDecision = resume.claimedWaiter.decision ?? 'rejected'
const decision: 'approved' | 'rejected' = rawDecision === 'approved' || rawDecision === 'force_passed'
  ? 'approved'
  : 'rejected'
const humanNotes = resume.claimedWaiter.rejectReason ?? null

// NEW: reject reroute
const retryToOnReject = typeof params.retryToOnReject === 'string' ? params.retryToOnReject : null
const REJECT_CAP = 3

if (decision === 'rejected' && retryToOnReject) {
  const currentCount = await getRejectCount(requirementId, nodeId)
  if (currentCount < REJECT_CAP) {
    await incrementRejectCount({
      requirementId, humanGateNodeId: nodeId, authorNodeId: retryToOnReject,
      rejectReason: humanNotes ?? '',
    })
    // setImmediate 让本 stage 函数先 return，旧 stream 标 failed 进 stop，再启新 stream
    setImmediate(() => {
      void retryFromNode(ctxBase.runId, retryToOnReject)
        .catch(err => console.error(`[human_gate] retryFromNode(${retryToOnReject}) failed:`, err))
    })
    const exec: StageExecutionResult = {
      status: 'failed',
      output: `${nodeId} rejected, scheduling retryFromNode(${retryToOnReject}) round ${currentCount + 1}`,
      error: 'reject_reroute',
    }
    return {
      currentStageIndex: index,
      stageResults: finishedResult({ ...node, name: stageName } as StageDefinition, startedAt, startedMs, exec),
      stepOutputs: {
        [nodeId]: {
          status: 'failed' as const,
          output: { decision: 'rejected', retryQueued: true, round: currentCount + 1, rejectReason: humanNotes },
        },
      },
    }
  }
  // else: cap reached — fall through to normal failed status, no retry queued
}

// 现有正常路径继续（approved → success / rejected exhausted → failed without retry）
```

**stream 切换保证**：本函数 return 后 LangGraph 看到 result.status='failed' + `onFailure: 'stop'`，让当前 stream 进入 skip_rest → END。`setImmediate` 在事件循环下个 tick 跑 `retryFromNode`，调 `updateState(asNode=predecessor) + stream`，重起新 stream 从 author 节点开始。两 stream 不并存（旧已 END，新启动）。

### 3.3 bootstrap.ts 配置

为三个非 final 的 *_human_gate 节点 params 加 `retryToOnReject`：

| 节点 | retryToOnReject |
|---|---|
| `spec_human_gate` | `'spec_author'` |
| `plan_human_gate` | `'plan_author'` |
| `dev_human_gate` | `'dev_author'` |
| `final_approval` | **不加** |

`final_approval` 缺 param → reject 走老路径 onFailure='stop' → 进 cleanup edge → abort 流程。语义：「final reject = 中止需求」（用户已经看完整体不满意）。

`QUICK_IMPL_TEMPLATE_VERSION` 需 bump 15 → 16，让 bootstrap reseed pipeline.graph。

### 3.4 `buildLlmAuthorNode` 注入 previousRound

[graph-builder.ts:buildLlmAuthorNode] 当前可能未消费 `last_reject_reasons`。改动：

```ts
// 在调 skillExecutor 前，读 reject reason 并构造 previousRound
const lastRejectReason = await getLastRejectReason(requirementId, node.id)  // 新 helper
const previousRound = lastRejectReason ? { rejectReason: lastRejectReason } : undefined

// 传给 skill-runner（已有机制）
const skillResult = await ctx.skillExecutor.runWithSkill({
  ...
  previousRound,
})
```

`getLastRejectReason(requirementId, authorNodeId)` 读 `retry_counters.last_reject_reasons[authorNodeId]`。skill-runner 拿到 previousRound.rejectReason 后写 `.qi-context/feedback.md`（[skill-runner.ts:578-581](../../../src/quick-impl/skill-runner.ts#L578-L581) 已有逻辑）。

### 3.5 `waiter.round` 真实递增

[graph-builder.ts:2594](../../../src/pipeline/graph-builder.ts#L2594) 硬编码 `round: 1`，改：

```ts
const currentRejects = await getRejectCount(requirementId, nodeId)
waiterRow = await createWaiter({
  ...,
  round: currentRejects + 1,  // round 1 = 第 1 次进入，每被 reject 一次递增
  ...
})
```

`getRejectCount` 在 reject **递增之前**调用，所以 round 1 first-time 时 count=0，round=1。reject 后 count++，下次进入 count=1, round=2。

### 3.6 UI — 决策下拉 disable reject

[RequirementsPage.tsx:1194-1212](../../../web/src/pages/RequirementsPage.tsx#L1194-L1212) 决策下拉：

```tsx
const rejectCount = detail?.retryCounters?.reject_counts?.[decideState.waiter?.nodeId ?? ''] ?? 0
const REJECT_CAP = 3
const rejectExhausted = rejectCount >= REJECT_CAP

<Select
  options={
    decideState.waiter?.decisionSet === 'plan_escalation'
      ? [...]  // 旧分支
      : [
          { value: 'approved',        label: '✅ 通过' },
          {
            value: 'rejected',
            label: rejectExhausted
              ? `❌ 拒绝（已达 ${REJECT_CAP} 轮上限，不能再 reject）`
              : '❌ 拒绝（要求修改）',
            disabled: rejectExhausted,
          },
          { value: 'force_passed',    label: '⚡ 强制通过（跳过评审）' },
          { value: 'budget_extended', label: '⏳ 延期（追加预算）' },
          { value: 'aborted',         label: '🛑 中止需求' },
        ]
  }
/>
```

`detail.retryCounters` 已经在 GET /admin/requirements/:id 响应里（[admin/routes/requirements.ts](../../../src/admin/routes/requirements.ts)），前端不需要新 API。

## 4. Acceptance Criteria

- **AC-1**: spec_human_gate 第 1 次 reject → `retry_counters.reject_counts.spec_human_gate` = 1 + `last_reject_reasons.spec_author` = rejectReason
- **AC-2**: spec_human_gate 第 1 次 reject 触发 `retryFromNode(runId, 'spec_author')` 异步执行
- **AC-3**: round 2 spec_author 跑时，skill-runner 写 `.qi-context/feedback.md` 含 rejectReason
- **AC-4**: round 2 spec_human_gate 创建的新 waiter `round=2`（不是硬编码 1）
- **AC-5**: 3 次 reject 后 retry_counters.reject_counts.spec_human_gate = 3，第 4 次进入 spec_human_gate 时 stage 标 failed 但 **不**调 retryFromNode（cap exhausted）
- **AC-6**: cap exhausted 状态下前端 GET 该需求 `retryCounters.reject_counts.spec_human_gate = 3`，决策下拉 reject 选项 disabled
- **AC-7**: cap exhausted 仍可选 force_passed / aborted / approved，三选一都能成功 claim waiter
- **AC-8**: final_approval reject → 不调 retryFromNode（因为没配 retryToOnReject）→ 走老 onFailure='stop' 路径
- **AC-9**: plan_human_gate / dev_human_gate 行为对称（reject 触发 plan_author / dev_author 重跑）
- **AC-10**: 不影响 approved 路径 — round 1 approve 不触发任何 reject 逻辑

## 5. e2e Scenarios

### 5.1 happy: 全链路 approve 跑通（**新增**，用户要求验证不回归）
- Given: 新建一个需求，pipeline 启动到 spec_human_gate round 1
- When: 决策选 approved（不点 reject）
- Then:
  - retry_counters.reject_counts.spec_human_gate **不存在**或 = 0
  - retryFromNode **未被调**
  - pipeline 继续走 spec_commit_push → plan_author → plan_ai_review → plan_human_gate（mode=on_fail，AI pass 直接跳）→ plan_commit_push → dev_author → ... → final_approval
  - final_approval approve → MR 创建（跳过 e2e_runner 因 skipE2E=true）

### 5.2 negative: spec round 1 reject → round 2 重写
- Given: spec_human_gate round 1 waiter active
- When: 决策 rejected，rejectReason="AC 不够具体，缺边界条件"
- Then:
  - reject_counts.spec_human_gate=1，last_reject_reasons.spec_author=rejectReason
  - retryFromNode('spec_author') 异步触发
  - spec_author round 2 跑时 `.qi-context/feedback.md` 含 rejectReason
  - 新 spec_human_gate waiter `round=2` 创建，contextSummary 是基于新 spec.md 的 buildSpecApprovalSummary 输出（与 round 1 不同）

### 5.3 negative: cap=3 上限触发 + 前端 UI disabled
- Given: spec_human_gate 已经 reject 3 次（reject_counts.spec_human_gate=3）
- When: 用户访问需求详情 + 打开决策弹窗
- Then:
  - 下拉选项 reject 灰色 + 文案 "❌ 拒绝（已达 3 轮上限，不能再 reject）"
  - 强制通过 / 中止需求 / 通过 三个选项可用

### 5.4 negative: final_approval reject = abort
- Given: final_approval waiter active
- When: 决策 rejected
- Then:
  - retryFromNode 不调（缺 retryToOnReject param）
  - pipeline 走 cleanup edge → abort

## 6. Risks

| Severity | Risk | Mitigation |
|---|---|---|
| high | setImmediate + 旧 stream halt + 新 stream 启动可能并发竞态：retryFromNode 调 updateState 时旧 stream 还在写 stage_results | retryFromNode 内部已 await `setRequirementStatus` + 重读 graph state — 串行的；setImmediate 让旧 stream 函数 return + LangGraph 完成 stage_results write 后才下个 tick 跑 retryFromNode |
| medium | `getRejectCount` 在 createWaiter 前调用如果跨 round 同 nodeId 复用 waiter（getActiveWaiter 命中）→ round 不递增 | 验证：旧 waiter 已 claimed，getActiveWaiter 找不到 active，必走 createWaiter 路径 — round 正确取新值 |
| medium | last_reject_reasons 一直累积不清理，cap exhausted 后下次新需求复用同 author nodeId 会读到旧 reason | last_reject_reasons 按 (requirementId, authorNodeId) namespaced（在 requirements 表里，每个需求隔离） |
| low | UI 可能 race — 用户在前端选了 reject 提交时后端已 cap exhausted | 后端 claimWaiter 层面校验：reject 决策 + cap exhausted → 拒绝 claim，返回 409 |

## 7. NoGos

- 不改 LangGraph cycle 边（Q4 design 决定走 app-level retryFromNode）
- 不动 final_approval 节点函数 — 缺 retryToOnReject 自然走老路径
- 不破坏 budget_extended 决策（保留现状，与 reject 解耦）
- 不修改 retryFromNode 接口（不加 previousRound 入参，状态通过 retry_counters 传）
- 不动 skill-runner 已有的 previousRound / feedback.md 机制

## 8. References

- [src/pipeline/graph-builder.ts:2483-2682](../../../src/pipeline/graph-builder.ts#L2483-L2682) — `buildHumanGateNode`
- [src/pipeline/graph-runner.ts:retryFromNode](../../../src/pipeline/graph-runner.ts) — 复用入口（昨天 Sub-plan E.1/E.2 实现）
- [src/quick-impl/skill-runner.ts:512-581](../../../src/quick-impl/skill-runner.ts#L512-L581) — `previousRound.rejectReason → feedback.md`
- [src/db/repositories/requirements.ts](../../../src/db/repositories/requirements.ts) — retry_counters 已有 jsonb_set helper
- [web/src/pages/RequirementsPage.tsx:1194-1212](../../../web/src/pages/RequirementsPage.tsx#L1194-L1212) — 决策下拉
- [src/quick-impl/bootstrap.ts](../../../src/quick-impl/bootstrap.ts) — QUICK_IMPL_TEMPLATE_VERSION = 15 → 16
