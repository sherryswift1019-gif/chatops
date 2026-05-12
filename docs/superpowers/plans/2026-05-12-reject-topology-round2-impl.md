# Reject 拓扑 + Round-2 重写机制 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `spec_human_gate` / `plan_human_gate` / `dev_human_gate` 的 `decision='rejected'` 自动触发对应 author 节点重跑（cap=3），上限到时前端 disable reject 选项。`final_approval` reject 维持 abort 语义。

**Architecture:** 应用层在 `buildHumanGateNode` 内部判断 rejected，setImmediate 异步调 [retryFromNode](../../../src/pipeline/graph-runner.ts)（昨天加的 helper）— 不改 graph 拓扑、不动 LangGraph cycle 边。Round 反馈用现有 `retry_counters` JSONB + skill-runner.previousRound → `.qi-context/feedback.md` 机制（已有）。

**Tech Stack:** TypeScript ES2022 + NodeNext, Vitest, LangGraph, PostgreSQL (jsonb_set), React 18 + Antd 5.

**Spec:** [docs/superpowers/specs/2026-05-12-reject-topology-round2-design.md](../specs/2026-05-12-reject-topology-round2-design.md)

---

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| [src/db/repositories/requirements.ts](../../../src/db/repositories/requirements.ts) | retry_counters JSONB helpers | T1 |
| [src/pipeline/graph-builder.ts](../../../src/pipeline/graph-builder.ts) | reject reroute + round 递增 + previousRound 注入 | T2/T3/T4 |
| [src/quick-impl/bootstrap.ts](../../../src/quick-impl/bootstrap.ts) | retryToOnReject params + version bump | T5 |
| [web/src/pages/requirements-helpers.ts](../../../web/src/pages/requirements-helpers.ts) | `buildDecisionOptions` helper | T6 |
| [web/src/pages/RequirementsPage.tsx](../../../web/src/pages/RequirementsPage.tsx) | 决策下拉接 helper | T6 |
| [src/__tests__/unit/requirements-retry-counters.test.ts](../../../src/__tests__/unit/requirements-retry-counters.test.ts) | T1 单测 | T1 |
| [src/__tests__/unit/human-gate-reject-reroute.test.ts](../../../src/__tests__/unit/human-gate-reject-reroute.test.ts) | T2 单测 | T2 |
| [src/__tests__/unit/llm-author-previous-round.test.ts](../../../src/__tests__/unit/llm-author-previous-round.test.ts) | T4 单测 | T4 |
| [src/__tests__/unit/quick-impl-bootstrap-topology.test.ts](../../../src/__tests__/unit/quick-impl-bootstrap-topology.test.ts) | T5 配置静态测试 | T5 |
| [web/src/pages/requirements-helpers.test.ts](../../../web/src/pages/requirements-helpers.test.ts) | T6 单测 | T6 |
| [src/__tests__/integration/qi-reject-round2.integration.test.ts](../../../src/__tests__/integration/qi-reject-round2.integration.test.ts) | T7 集成测 | T7 |

---

## Task 1: retry_counters JSONB helpers

**Files:**
- Modify: [src/db/repositories/requirements.ts](../../../src/db/repositories/requirements.ts) (+3 functions ≈ 60 lines)
- Test: [src/__tests__/unit/requirements-retry-counters.test.ts](../../../src/__tests__/unit/requirements-retry-counters.test.ts) (new file)

**Covers AC-1 (counter increment) data layer.**

### Step 1.1 — Write failing tests

- [ ] **Step 1.1**: Create [src/__tests__/unit/requirements-retry-counters.test.ts](../../../src/__tests__/unit/requirements-retry-counters.test.ts):

```typescript
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { resetTestDb } from '../helpers/db.js'
import {
  createRequirement,
  getRejectCount,
  incrementRejectCount,
  getLastRejectReason,
  getRequirementById,
} from '../../db/repositories/requirements.js'

describe('retry_counters reject helpers', () => {
  let reqId: number

  beforeAll(async () => { await resetTestDb() })

  beforeEach(async () => {
    const r = await createRequirement({
      title: 't', rawInput: 'r', gitlabProject: 'g/p', source: 'web', status: 'draft',
    })
    reqId = r.id
  })

  it('getRejectCount: 新需求返回 0', async () => {
    expect(await getRejectCount(reqId, 'spec_human_gate')).toBe(0)
  })

  it('incrementRejectCount: 首次累加 0→1，写入 reject_counts + last_reject_reasons', async () => {
    const result = await incrementRejectCount({
      requirementId: reqId,
      humanGateNodeId: 'spec_human_gate',
      authorNodeId: 'spec_author',
      rejectReason: 'AC 不够具体',
    })
    expect(result.newCount).toBe(1)
    expect(await getRejectCount(reqId, 'spec_human_gate')).toBe(1)
    expect(await getLastRejectReason(reqId, 'spec_author')).toBe('AC 不够具体')
  })

  it('incrementRejectCount: 第 2 次累加 1→2，rejectReason 覆盖', async () => {
    await incrementRejectCount({
      requirementId: reqId, humanGateNodeId: 'spec_human_gate', authorNodeId: 'spec_author',
      rejectReason: 'round 1 reason',
    })
    const result = await incrementRejectCount({
      requirementId: reqId, humanGateNodeId: 'spec_human_gate', authorNodeId: 'spec_author',
      rejectReason: 'round 2 reason',
    })
    expect(result.newCount).toBe(2)
    expect(await getLastRejectReason(reqId, 'spec_author')).toBe('round 2 reason')
  })

  it('incrementRejectCount: 多 node 互不干扰', async () => {
    await incrementRejectCount({
      requirementId: reqId, humanGateNodeId: 'spec_human_gate', authorNodeId: 'spec_author',
      rejectReason: 's',
    })
    await incrementRejectCount({
      requirementId: reqId, humanGateNodeId: 'plan_human_gate', authorNodeId: 'plan_author',
      rejectReason: 'p',
    })
    expect(await getRejectCount(reqId, 'spec_human_gate')).toBe(1)
    expect(await getRejectCount(reqId, 'plan_human_gate')).toBe(1)
    expect(await getLastRejectReason(reqId, 'spec_author')).toBe('s')
    expect(await getLastRejectReason(reqId, 'plan_author')).toBe('p')
  })

  it('getLastRejectReason: 不存在返回 null', async () => {
    expect(await getLastRejectReason(reqId, 'spec_author')).toBeNull()
  })

  it('incrementRejectCount: 与现有 node_retry_counts 并存（不互相覆盖）', async () => {
    // 先种 node_retry_counts（模拟 NODE_RETRY_CAP 计数）
    const pool = (await import('../../db/client.js')).getPool()
    await pool.query(
      `UPDATE requirements SET retry_counters = jsonb_set(
        COALESCE(retry_counters, '{}'::jsonb),
        '{node_retry_counts,spec_author}',
        '2'::jsonb, true
      ) WHERE id = $1`,
      [reqId],
    )
    await incrementRejectCount({
      requirementId: reqId, humanGateNodeId: 'spec_human_gate', authorNodeId: 'spec_author',
      rejectReason: 'x',
    })
    const r = await getRequirementById(reqId)
    expect(r!.retryCounters.node_retry_counts?.spec_author).toBe(2)
    expect(r!.retryCounters.reject_counts?.spec_human_gate).toBe(1)
  })
})
```

### Step 1.2 — Run test, verify RED

- [ ] **Step 1.2**: Run.

Run: `CI=true npx vitest run src/__tests__/unit/requirements-retry-counters.test.ts`

Expected: 6 tests fail — `getRejectCount/incrementRejectCount/getLastRejectReason is not a function` or import error.

Note: testcontainer needs Docker. If Docker unavailable, the test will fail at globalSetup; that's acceptable here — we'll verify in T8 at end. **If Docker is available**, all 6 tests fail with the import error pattern.

### Step 1.3 — Implement helpers

- [ ] **Step 1.3**: Append to [src/db/repositories/requirements.ts](../../../src/db/repositories/requirements.ts) (after existing retry_counter functions, locate by `grep -n "retry_counters\|jsonb_set" src/db/repositories/requirements.ts | head`):

```typescript
/**
 * 读 retry_counters.reject_counts[humanGateNodeId]，默认 0。
 * 用于 *_human_gate 节点判断 reject 是否达 cap。
 */
export async function getRejectCount(
  requirementId: number,
  humanGateNodeId: string,
): Promise<number> {
  const pool = getPool()
  const { rows } = await pool.query<{ count: number | null }>(
    `SELECT (retry_counters->'reject_counts'->>$2)::int AS count
     FROM requirements WHERE id = $1`,
    [requirementId, humanGateNodeId],
  )
  return rows[0]?.count ?? 0
}

/**
 * 原子累加 reject_counts[humanGateNodeId]++ 同时写入 last_reject_reasons[authorNodeId]。
 * 用 jsonb_set 双 path 单事务保证一致。
 */
export async function incrementRejectCount(args: {
  requirementId: number
  humanGateNodeId: string
  authorNodeId: string
  rejectReason: string
}): Promise<{ newCount: number }> {
  const { requirementId, humanGateNodeId, authorNodeId, rejectReason } = args
  const pool = getPool()
  const { rows } = await pool.query<{ count: number }>(
    `UPDATE requirements
     SET retry_counters = jsonb_set(
       jsonb_set(
         COALESCE(retry_counters, '{}'::jsonb),
         ARRAY['reject_counts', $2::text],
         to_jsonb(COALESCE((retry_counters->'reject_counts'->>$2)::int, 0) + 1),
         true
       ),
       ARRAY['last_reject_reasons', $3::text],
       to_jsonb($4::text),
       true
     )
     WHERE id = $1
     RETURNING (retry_counters->'reject_counts'->>$2)::int AS count`,
    [requirementId, humanGateNodeId, authorNodeId, rejectReason],
  )
  return { newCount: rows[0]?.count ?? 0 }
}

/**
 * 读 retry_counters.last_reject_reasons[authorNodeId]，不存在返回 null。
 * 用于 buildLlmAuthorNode 注入 previousRound.rejectReason。
 */
export async function getLastRejectReason(
  requirementId: number,
  authorNodeId: string,
): Promise<string | null> {
  const pool = getPool()
  const { rows } = await pool.query<{ reason: string | null }>(
    `SELECT retry_counters->'last_reject_reasons'->>$2 AS reason
     FROM requirements WHERE id = $1`,
    [requirementId, authorNodeId],
  )
  return rows[0]?.reason ?? null
}
```

### Step 1.4 — Run test, verify GREEN

- [ ] **Step 1.4**: Run.

Run: `CI=true npx vitest run src/__tests__/unit/requirements-retry-counters.test.ts`

Expected: 6 tests pass.

### Step 1.5 — Typecheck

- [ ] **Step 1.5**: Run.

Run: `pnpm exec tsc --noEmit`

Expected: silent.

### Step 1.6 — Commit

- [ ] **Step 1.6**: Commit.

```bash
git add src/db/repositories/requirements.ts src/__tests__/unit/requirements-retry-counters.test.ts
git commit -m "feat(requirements): retry_counters 加 reject_counts + last_reject_reasons helpers

getRejectCount / incrementRejectCount / getLastRejectReason — *_human_gate 节点
reject reroute 用，jsonb_set 双 path 原子累加。

Reject_counts key 是 human_gate nodeId（如 spec_human_gate），last_reject_reasons
key 是 author nodeId（如 spec_author）— 两套语义独立。

为 reject 拓扑 + round-2 重写机制做准备（spec §3.1）。"
```

---

## Task 2: `buildHumanGateNode` reject reroute 分支

**Files:**
- Modify: [src/pipeline/graph-builder.ts:2621-2629](../../../src/pipeline/graph-builder.ts#L2621-L2629) (insert reject-reroute branch after `interrupt()` returns)
- Test: [src/__tests__/unit/human-gate-reject-reroute.test.ts](../../../src/__tests__/unit/human-gate-reject-reroute.test.ts) (new file)

**Covers AC-1/2/5/8 — reject reroute trigger and cap exhaustion.**

### Step 2.1 — Write failing test (mock state + verify retryFromNode + setImmediate)

- [ ] **Step 2.1**: Create [src/__tests__/unit/human-gate-reject-reroute.test.ts](../../../src/__tests__/unit/human-gate-reject-reroute.test.ts):

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock retryFromNode 在 graph-runner.ts，需要 dynamic import 避免 mock 时机问题
vi.mock('../../pipeline/graph-runner.js', () => ({
  retryFromNode: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../db/repositories/requirements.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/repositories/requirements.js')>()
  return {
    ...actual,
    getRejectCount: vi.fn(),
    incrementRejectCount: vi.fn(),
    setRequirementStatus: vi.fn().mockResolvedValue(undefined),
  }
})

import { retryFromNode } from '../../pipeline/graph-runner.js'
import { getRejectCount, incrementRejectCount } from '../../db/repositories/requirements.js'
import { handleHumanGateRejection } from '../../pipeline/graph-builder.js'

describe('handleHumanGateRejection (extracted helper)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reject 未达 cap → 触发 retryFromNode + 累加 + return status=failed 含 retryQueued', async () => {
    vi.mocked(getRejectCount).mockResolvedValue(0)
    vi.mocked(incrementRejectCount).mockResolvedValue({ newCount: 1 })
    
    const result = await handleHumanGateRejection({
      runId: 100,
      requirementId: 7,
      humanGateNodeId: 'spec_human_gate',
      retryToOnReject: 'spec_author',
      rejectReason: 'AC 不够具体',
    })
    
    expect(result.shouldReroute).toBe(true)
    expect(result.newCount).toBe(1)
    expect(getRejectCount).toHaveBeenCalledWith(7, 'spec_human_gate')
    expect(incrementRejectCount).toHaveBeenCalledWith({
      requirementId: 7,
      humanGateNodeId: 'spec_human_gate',
      authorNodeId: 'spec_author',
      rejectReason: 'AC 不够具体',
    })
    // retryFromNode 在 setImmediate 里被 schedule —— 用 setTimeout(0) 等一个 tick
    await new Promise(r => setTimeout(r, 10))
    expect(retryFromNode).toHaveBeenCalledWith(100, 'spec_author')
  })

  it('reject 已达 cap=3 → 不调 retryFromNode + 不累加 + shouldReroute=false', async () => {
    vi.mocked(getRejectCount).mockResolvedValue(3)
    
    const result = await handleHumanGateRejection({
      runId: 100,
      requirementId: 7,
      humanGateNodeId: 'spec_human_gate',
      retryToOnReject: 'spec_author',
      rejectReason: '4th try',
    })
    
    expect(result.shouldReroute).toBe(false)
    expect(incrementRejectCount).not.toHaveBeenCalled()
    await new Promise(r => setTimeout(r, 10))
    expect(retryFromNode).not.toHaveBeenCalled()
  })

  it('reject 未配 retryToOnReject → shouldReroute=false（不调 retry）', async () => {
    vi.mocked(getRejectCount).mockResolvedValue(0)
    
    const result = await handleHumanGateRejection({
      runId: 100,
      requirementId: 7,
      humanGateNodeId: 'final_approval',
      retryToOnReject: null,
      rejectReason: 'final reject',
    })
    
    expect(result.shouldReroute).toBe(false)
    expect(getRejectCount).not.toHaveBeenCalled()
    expect(incrementRejectCount).not.toHaveBeenCalled()
    await new Promise(r => setTimeout(r, 10))
    expect(retryFromNode).not.toHaveBeenCalled()
  })

  it('cap 边界：count=2 时 reject 可执行（< 3）', async () => {
    vi.mocked(getRejectCount).mockResolvedValue(2)
    vi.mocked(incrementRejectCount).mockResolvedValue({ newCount: 3 })
    
    const result = await handleHumanGateRejection({
      runId: 100,
      requirementId: 7,
      humanGateNodeId: 'spec_human_gate',
      retryToOnReject: 'spec_author',
      rejectReason: 'round 3 reject',
    })
    
    expect(result.shouldReroute).toBe(true)
    expect(result.newCount).toBe(3)
  })
})
```

### Step 2.2 — Run test, verify RED

- [ ] **Step 2.2**: Run.

Run: `CI=true npx vitest run src/__tests__/unit/human-gate-reject-reroute.test.ts`

Expected: 4 tests fail — `handleHumanGateRejection is not a function`.

### Step 2.3 — Implement `handleHumanGateRejection` helper

- [ ] **Step 2.3**: In [src/pipeline/graph-builder.ts](../../../src/pipeline/graph-builder.ts), find the import block at top and add:

```typescript
import { getRejectCount, incrementRejectCount } from '../db/repositories/requirements.js'
```

Then, **above** the `buildHumanGateNode` function (around line 2483), add the helper:

```typescript
/**
 * Reject reroute 决策 helper —— 提取自 buildHumanGateNode，便于单测。
 *
 * Returns:
 *   shouldReroute=true  → caller 标 stage failed (让 stream stop) + setImmediate 已 schedule retry
 *   shouldReroute=false → caller 走原 rejected 路径（cap 满或无 retryToOnReject）
 *
 * 安全保证：retryFromNode 在 setImmediate 里 fire-and-forget，让本函数 return 后
 * LangGraph stream 先进 skip_rest，再下个 event-loop tick 启新 stream。两 stream 不并发。
 */
export const REJECT_CAP = 3

export async function handleHumanGateRejection(args: {
  runId: number
  requirementId: number
  humanGateNodeId: string
  retryToOnReject: string | null
  rejectReason: string
}): Promise<{ shouldReroute: boolean; newCount: number }> {
  const { runId, requirementId, humanGateNodeId, retryToOnReject, rejectReason } = args

  if (!retryToOnReject) return { shouldReroute: false, newCount: 0 }

  const currentCount = await getRejectCount(requirementId, humanGateNodeId)
  if (currentCount >= REJECT_CAP) return { shouldReroute: false, newCount: currentCount }

  const { newCount } = await incrementRejectCount({
    requirementId, humanGateNodeId, authorNodeId: retryToOnReject, rejectReason,
  })

  // Dynamic import 避免循环依赖（graph-runner.ts 也 import graph-builder.ts）
  setImmediate(async () => {
    try {
      const { retryFromNode } = await import('./graph-runner.js')
      await retryFromNode(runId, retryToOnReject)
    } catch (err) {
      console.error(`[human_gate] retryFromNode(${retryToOnReject}) for run ${runId} failed:`, err)
    }
  })

  return { shouldReroute: true, newCount }
}
```

### Step 2.4 — Wire `handleHumanGateRejection` into `buildHumanGateNode`

- [ ] **Step 2.4**: In [graph-builder.ts](../../../src/pipeline/graph-builder.ts) find around line 2621 where `interrupt(interruptPayload)` returns, and replace the decision handling. Locate the block:

```typescript
    const resume = interrupt(interruptPayload) as QiApprovalResume

    const rawDecision = resume.claimedWaiter.decision ?? 'rejected'
    const decision: 'approved' | 'rejected' = rawDecision === 'approved' || rawDecision === 'force_passed'
      ? 'approved'
      : 'rejected'
    const humanNotes = resume.claimedWaiter.rejectReason ?? null
    const decidedBy = resume.claimedWaiter.decidedBy ?? resume.claimedWaiter.claimedBy ?? null
```

Insert AFTER the `decidedBy` assignment:

```typescript
    // === REJECT REROUTE ===
    // 当 *_human_gate 配了 retryToOnReject param 且 reject 未达 cap，触发 retryFromNode
    // 重起 author 节点（spec/plan/dev_author），传 rejectReason 给下轮 LLM 作 feedback。
    // 见 docs/superpowers/specs/2026-05-12-reject-topology-round2-design.md
    if (decision === 'rejected') {
      const retryToOnReject = typeof params.retryToOnReject === 'string' ? params.retryToOnReject : null
      const { shouldReroute, newCount } = await handleHumanGateRejection({
        runId: ctxBase.runId,
        requirementId,
        humanGateNodeId: nodeId,
        retryToOnReject,
        rejectReason: humanNotes ?? '',
      })
      if (shouldReroute) {
        const exec: StageExecutionResult = {
          status: 'failed',
          output: `${nodeId} rejected, scheduled retryFromNode(${retryToOnReject}) — round ${newCount}`,
          error: 'reject_reroute',
        }
        return {
          currentStageIndex: index,
          stageResults: finishedResult({ ...node, name: stageName } as StageDefinition, startedAt, startedMs, exec),
          stepOutputs: {
            [nodeId]: {
              status: 'failed' as const,
              output: { decision: 'rejected', retryQueued: true, round: newCount, rejectReason: humanNotes },
            },
          },
        }
      }
      // shouldReroute=false: cap reached OR no retryToOnReject configured —— fall through to original rejected path
    }
    // === END REJECT REROUTE ===
```

### Step 2.5 — Run test, verify GREEN

- [ ] **Step 2.5**: Run.

Run: `CI=true npx vitest run src/__tests__/unit/human-gate-reject-reroute.test.ts`

Expected: 4 tests pass.

### Step 2.6 — Typecheck

- [ ] **Step 2.6**: Run.

Run: `pnpm exec tsc --noEmit`

Expected: silent.

### Step 2.7 — Commit

- [ ] **Step 2.7**: Commit.

```bash
git add src/pipeline/graph-builder.ts src/__tests__/unit/human-gate-reject-reroute.test.ts
git commit -m "feat(human_gate): reject reroute — 调 retryFromNode 重跑 author 节点

新 helper handleHumanGateRejection 提取出来便于单测。
*_human_gate 节点配 params.retryToOnReject='<author_node_id>' 时，
reject 决策触发 retryFromNode(runId, author_node_id) 重跑该 author，
带上轮 rejectReason 作为 previousRound feedback。

cap=3 上限到时不触发 retry，走原 onFailure='stop' 路径。
final_approval 缺 retryToOnReject param 自然走 abort（spec §3.5）。

stream 切换：setImmediate 让本 stage 函数 return + LangGraph stream
END 后才下个 tick 启新 stream，避免并发。

为 reject 拓扑 + round-2 重写机制实现（spec §3.2）。"
```

---

## Task 3: `waiter.round` 真实递增

**Files:**
- Modify: [src/pipeline/graph-builder.ts:2585-2598](../../../src/pipeline/graph-builder.ts#L2585-L2598) (createWaiter call site)
- Test: [src/__tests__/unit/human-gate-reject-reroute.test.ts](../../../src/__tests__/unit/human-gate-reject-reroute.test.ts) (extend with 2 cases)

**Covers AC-4 — round 真实递增。**

### Step 3.1 — Write failing test

- [ ] **Step 3.1**: Append to [src/__tests__/unit/human-gate-reject-reroute.test.ts](../../../src/__tests__/unit/human-gate-reject-reroute.test.ts) (in the same `describe` block or new describe at file end):

```typescript
describe('computeWaiterRound (extracted helper)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('count=0 → round 1（首次进入 spec_human_gate）', async () => {
    vi.mocked(getRejectCount).mockResolvedValue(0)
    const { computeWaiterRound } = await import('../../pipeline/graph-builder.js')
    expect(await computeWaiterRound(7, 'spec_human_gate')).toBe(1)
  })

  it('count=2 → round 3（已被 reject 2 次，下一轮是第 3 轮）', async () => {
    vi.mocked(getRejectCount).mockResolvedValue(2)
    const { computeWaiterRound } = await import('../../pipeline/graph-builder.js')
    expect(await computeWaiterRound(7, 'spec_human_gate')).toBe(3)
  })
})
```

### Step 3.2 — Run test, verify RED

- [ ] **Step 3.2**: Run.

Run: `CI=true npx vitest run src/__tests__/unit/human-gate-reject-reroute.test.ts -t "computeWaiterRound"`

Expected: 2 tests fail — `computeWaiterRound is not a function`.

### Step 3.3 — Add `computeWaiterRound` helper + wire to createWaiter

- [ ] **Step 3.3**: In [src/pipeline/graph-builder.ts](../../../src/pipeline/graph-builder.ts), **next to** `handleHumanGateRejection` (above buildHumanGateNode), add:

```typescript
/**
 * 计算 waiter.round。规则：reject_counts[humanGateNodeId] + 1。
 * count=0 → round 1（首次进入）；reject 一次后 count=1 → round 2；以此类推。
 * 取代 [graph-builder.ts:2594] 硬编码 round=1（spec §3.5）。
 */
export async function computeWaiterRound(
  requirementId: number,
  humanGateNodeId: string,
): Promise<number> {
  const count = await getRejectCount(requirementId, humanGateNodeId)
  return count + 1
}
```

Then in `buildHumanGateNode` around [line 2585-2598](../../../src/pipeline/graph-builder.ts#L2585-L2598), find:

```typescript
    let waiterRow: RequirementApprovalWaiter
    const existing = await getActiveWaiter(requirementId, nodeId)
    if (existing) {
      waiterRow = existing
    } else {
      waiterRow = await createWaiter({
        requirementId,
        pipelineRunId: ctxBase.runId,
        nodeId,
        approvalKind,
        round: 1,
        decisionSet: 'human_gate',
        contextSummary,
      })
    }
```

Change `round: 1,` to `round: await computeWaiterRound(requirementId, nodeId),`:

```typescript
    let waiterRow: RequirementApprovalWaiter
    const existing = await getActiveWaiter(requirementId, nodeId)
    if (existing) {
      waiterRow = existing
    } else {
      waiterRow = await createWaiter({
        requirementId,
        pipelineRunId: ctxBase.runId,
        nodeId,
        approvalKind,
        round: await computeWaiterRound(requirementId, nodeId),
        decisionSet: 'human_gate',
        contextSummary,
      })
    }
```

### Step 3.4 — Run test, verify GREEN

- [ ] **Step 3.4**: Run.

Run: `CI=true npx vitest run src/__tests__/unit/human-gate-reject-reroute.test.ts`

Expected: all 6 tests pass.

### Step 3.5 — Typecheck

- [ ] **Step 3.5**: Run.

Run: `pnpm exec tsc --noEmit`

Expected: silent.

### Step 3.6 — Commit

- [ ] **Step 3.6**: Commit.

```bash
git add src/pipeline/graph-builder.ts src/__tests__/unit/human-gate-reject-reroute.test.ts
git commit -m "feat(human_gate): waiter.round 真实递增 = getRejectCount + 1

取代硬编码 round=1。新 helper computeWaiterRound 让单测可验。
首次进入 round=1；reject 一次后 round=2；以此类推。

依赖 reject_counts JSONB（T1）。spec §3.5。"
```

---

## Task 4: `buildLlmAuthorNode` 注入 previousRound

**Files:**
- Modify: [src/pipeline/graph-builder.ts](../../../src/pipeline/graph-builder.ts) — find `buildLlmAuthorNode` and inject `previousRound`
- Test: [src/__tests__/unit/llm-author-previous-round.test.ts](../../../src/__tests__/unit/llm-author-previous-round.test.ts) (new file)

**Covers AC-3 — `.qi-context/feedback.md` 含 rejectReason。**

### Step 4.1 — Find current `buildLlmAuthorNode` skillExecutor call pattern

- [ ] **Step 4.1**: Run.

```bash
grep -n "function buildLlmAuthorNode\|previousRound\|skillExecutor.runWithSkill\|skillExecutor.execute" src/pipeline/graph-builder.ts | head -20
```

Read 30 lines starting from `function buildLlmAuthorNode` definition to understand current shape. Note the line range you need to modify (likely the block constructing skill-runner inputs around mid-function).

### Step 4.2 — Write failing test (RED)

- [ ] **Step 4.2**: Create [src/__tests__/unit/llm-author-previous-round.test.ts](../../../src/__tests__/unit/llm-author-previous-round.test.ts):

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../db/repositories/requirements.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/repositories/requirements.js')>()
  return {
    ...actual,
    getLastRejectReason: vi.fn(),
  }
})

import { getLastRejectReason } from '../../db/repositories/requirements.js'
import { resolveLlmAuthorPreviousRound } from '../../pipeline/graph-builder.js'

describe('resolveLlmAuthorPreviousRound (helper for buildLlmAuthorNode)', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('last_reject_reasons 含值 → 返回 { rejectReason }', async () => {
    vi.mocked(getLastRejectReason).mockResolvedValue('AC 太模糊')
    const result = await resolveLlmAuthorPreviousRound(7, 'spec_author')
    expect(result).toEqual({ rejectReason: 'AC 太模糊' })
    expect(getLastRejectReason).toHaveBeenCalledWith(7, 'spec_author')
  })

  it('last_reject_reasons 不存在 → 返回 undefined（不注入 previousRound）', async () => {
    vi.mocked(getLastRejectReason).mockResolvedValue(null)
    const result = await resolveLlmAuthorPreviousRound(7, 'spec_author')
    expect(result).toBeUndefined()
  })

  it('空字符串 rejectReason → 返回 undefined（防止注入空反馈）', async () => {
    vi.mocked(getLastRejectReason).mockResolvedValue('')
    const result = await resolveLlmAuthorPreviousRound(7, 'spec_author')
    expect(result).toBeUndefined()
  })
})
```

### Step 4.3 — Run test, verify RED

- [ ] **Step 4.3**: Run.

Run: `CI=true npx vitest run src/__tests__/unit/llm-author-previous-round.test.ts`

Expected: 3 tests fail — `resolveLlmAuthorPreviousRound is not a function`.

### Step 4.4 — Implement helper + wire into `buildLlmAuthorNode`

- [ ] **Step 4.4**: In [src/pipeline/graph-builder.ts](../../../src/pipeline/graph-builder.ts), add to import:

```typescript
import { getLastRejectReason } from '../db/repositories/requirements.js'  // 注意：如果已有 getRejectCount import，extend 这一行
```

(Update existing import line from T1/T2 if it already imports `getRejectCount, incrementRejectCount`:)

```typescript
import { getRejectCount, incrementRejectCount, getLastRejectReason } from '../db/repositories/requirements.js'
```

Add helper next to other extracted helpers (near `handleHumanGateRejection`):

```typescript
/**
 * 读 last_reject_reasons[authorNodeId] 构造 previousRound 入参。
 * 空 / null 返回 undefined（让 skill-runner 跳过 feedback.md 写入）。
 *
 * 用于 buildLlmAuthorNode 在调 skillExecutor 前注入 previousRound — 让 spec/plan/dev-author
 * 在 round N+1 看到上轮 rejectReason，调整产出（spec §3.4）。
 */
export async function resolveLlmAuthorPreviousRound(
  requirementId: number,
  authorNodeId: string,
): Promise<{ rejectReason: string } | undefined> {
  const reason = await getLastRejectReason(requirementId, authorNodeId)
  if (!reason) return undefined
  return { rejectReason: reason }
}
```

Then in `buildLlmAuthorNode`, **before** the call to `ctx.skillExecutor.runWithSkill(...)` (or whichever skill-executor invocation it uses — locate via grep in Step 4.1), inject:

```typescript
const previousRound = await resolveLlmAuthorPreviousRound(requirementId, node.id)

// Then add `previousRound,` (when defined) to the skill-runner call options object.
// Example shape (the real call site may differ — adapt to existing signature):
const skillResult = await ctx.skillExecutor.runWithSkill({
  // ... existing options
  previousRound,  // undefined when no prior reject
})
```

⚠️ **engineer must read existing buildLlmAuthorNode body** (Step 4.1 grep showed structure) **and find the exact skillExecutor call shape**. If the call already takes `previousRound: PreviousRoundData | undefined` (likely — skill-runner.ts:512 has it), this is just adding one field. If not, extend the option type.

### Step 4.5 — Run test, verify GREEN

- [ ] **Step 4.5**: Run.

Run: `CI=true npx vitest run src/__tests__/unit/llm-author-previous-round.test.ts`

Expected: 3 tests pass.

### Step 4.6 — Typecheck

- [ ] **Step 4.6**: Run.

Run: `pnpm exec tsc --noEmit`

Expected: silent.

### Step 4.7 — Commit

- [ ] **Step 4.7**: Commit.

```bash
git add src/pipeline/graph-builder.ts src/__tests__/unit/llm-author-previous-round.test.ts
git commit -m "feat(llm_author): 注入 previousRound.rejectReason

新 helper resolveLlmAuthorPreviousRound 读 last_reject_reasons[authorNodeId]，
传给 skill-runner — skill-runner 已有的 previousRound → .qi-context/feedback.md
机制（skill-runner.ts:578）自动生效，让 author LLM 在 round N+1 看到反馈。

依赖 last_reject_reasons JSONB（T1）。spec §3.4。"
```

---

## Task 5: bootstrap.ts 加 retryToOnReject + bump version

**Files:**
- Modify: [src/quick-impl/bootstrap.ts](../../../src/quick-impl/bootstrap.ts) — 3 处 makeNode(*_human_gate) params + version 15→16 + jsdoc
- Test: [src/__tests__/unit/quick-impl-bootstrap-topology.test.ts](../../../src/__tests__/unit/quick-impl-bootstrap-topology.test.ts) (new, no DB)

**Covers AC-8 (final_approval 不配 retryToOnReject) and config correctness.**

### Step 5.1 — Write failing test

- [ ] **Step 5.1**: Create [src/__tests__/unit/quick-impl-bootstrap-topology.test.ts](../../../src/__tests__/unit/quick-impl-bootstrap-topology.test.ts):

```typescript
import { describe, it, expect } from 'vitest'
import { buildQuickImplGraph, QUICK_IMPL_TEMPLATE_VERSION } from '../../quick-impl/bootstrap.js'

describe('Quick-Impl bootstrap v16 — reject reroute params', () => {
  it('QUICK_IMPL_TEMPLATE_VERSION bumped to 16', () => {
    expect(QUICK_IMPL_TEMPLATE_VERSION).toBe(16)
  })

  it('spec_human_gate.params.retryToOnReject = "spec_author"', () => {
    const g = buildQuickImplGraph()
    const n = g.nodes.find((x) => x.id === 'spec_human_gate')
    expect(n).toBeDefined()
    const params = (n as { params?: Record<string, unknown> }).params ?? {}
    expect(params.retryToOnReject).toBe('spec_author')
  })

  it('plan_human_gate.params.retryToOnReject = "plan_author"', () => {
    const g = buildQuickImplGraph()
    const n = g.nodes.find((x) => x.id === 'plan_human_gate')
    const params = (n as { params?: Record<string, unknown> }).params ?? {}
    expect(params.retryToOnReject).toBe('plan_author')
  })

  it('dev_human_gate.params.retryToOnReject = "dev_author"', () => {
    const g = buildQuickImplGraph()
    const n = g.nodes.find((x) => x.id === 'dev_human_gate')
    const params = (n as { params?: Record<string, unknown> }).params ?? {}
    expect(params.retryToOnReject).toBe('dev_author')
  })

  it('final_approval.params **不含** retryToOnReject（reject = abort 语义）', () => {
    const g = buildQuickImplGraph()
    const n = g.nodes.find((x) => x.id === 'final_approval')
    const params = (n as { params?: Record<string, unknown> }).params ?? {}
    expect(params.retryToOnReject).toBeUndefined()
  })
})
```

### Step 5.2 — Run test, verify RED

- [ ] **Step 5.2**: Run.

Run: `CI=true npx vitest run src/__tests__/unit/quick-impl-bootstrap-topology.test.ts`

Expected: 4 tests fail (version still 15, params missing retryToOnReject).

### Step 5.3 — Implement config changes

- [ ] **Step 5.3**: In [src/quick-impl/bootstrap.ts](../../../src/quick-impl/bootstrap.ts) update the version jsdoc + constant:

Replace lines around 16-25:

```typescript
/**
 * v8 → v9: e2e_stub 替换为 qi_e2e_runner 子机（含 fix-loop / IM 人工介入）。
 * v8 in-flight QI run 仍走 v8 graph 快照（test_pipelines.graph 在 run 启动时绑定）。
 * v11 → v12: spec/plan/dev 阶段拆为原子节点（author/ai_review/human_gate/commit_push），
 * final_approval 改用 human_gate，mr_create_skip 替换为 cleanup + done。共 25 节点。
 * v12 → v13: cleanup 节点 targets 加 remote_branch + draft_mr，abort 路径闭环清远端资源。
 * v13 → v14: dev_push 后插 e2e_skip_router (switch)，按 triggerParams.skipE2E 路由：
 *   true → final_approval（整段 E2E 跳过）；false → qi_e2e_runner（原拓扑不变）。
 * v14 → v15: spec_human_gate.params 加 summaryKind/skillOutput/artifactPath/round，
 *   让 buildHumanGateNode 调 buildSpecApprovalSummary 产 5 段 web 摘要（修空白决策弹窗 bug）。
 *   dev_human_gate.approvalKind 'plan' → 'dev'，IM/Web 卡片标签不再错位。
 * v15 → v16: spec/plan/dev_human_gate.params 加 retryToOnReject = '<author_node_id>'，
 *   让 reject 决策触发 retryFromNode 重跑对应 author。final_approval 不配（reject = abort 语义）。
 */
export const QUICK_IMPL_TEMPLATE_VERSION = 16
```

Update spec_human_gate (around [line 99-118](../../../src/quick-impl/bootstrap.ts#L99-L118)) — locate via `grep -n "spec_human_gate" src/quick-impl/bootstrap.ts`:

```typescript
    makeNode('spec_human_gate', {
      name: 'Spec Human Gate',
      stageType: 'human_gate',
      onFailure: 'stop',
      params: {
        requirementId: '{{triggerParams.requirementId}}',
        mode: 'required',
        timeoutSeconds: 86400,
        onTimeout: 'reject',
        approvalKind: 'spec',
        approverIds: '{{vars.qiApproverIds}}',
        source: 'ai_pass',
        artifact: '{{steps.spec_author.output.skillOutput}}',
        aiReview: '{{steps.spec_ai_review.output}}',
        // 高保真审批摘要：让 buildHumanGateNode 调 buildSpecApprovalSummary（5 段 web + 折叠 spec.md）
        summaryKind: 'spec',
        skillOutput: '{{steps.spec_author.output.skillOutput}}',
        artifactPath: '{{steps.init_branch.output.worktreePath}}/docs/specs/qi-{{triggerParams.requirementId}}.md',
        round: 1,
        // v16: reject 决策时让 buildHumanGateNode 调 retryFromNode(spec_author) 重写 spec
        retryToOnReject: 'spec_author',
      },
    } as any),
```

Update plan_human_gate (locate via `grep -n "plan_human_gate" src/quick-impl/bootstrap.ts`):

```typescript
    makeNode('plan_human_gate', {
      name: 'Plan Human Gate',
      stageType: 'human_gate',
      onFailure: 'stop',
      params: {
        // ... existing params unchanged
        // v16: reject → plan_author 重写
        retryToOnReject: 'plan_author',
      },
    } as any),
```

Update dev_human_gate (locate via `grep -n "dev_human_gate" src/quick-impl/bootstrap.ts`):

```typescript
    makeNode('dev_human_gate', {
      name: 'Dev Human Gate',
      stageType: 'human_gate',
      onFailure: 'stop',
      params: {
        // ... existing params unchanged
        // v16: reject → dev_author 重写
        retryToOnReject: 'dev_author',
      },
    } as any),
```

**Do NOT** add `retryToOnReject` to `final_approval` — its absence is intentional (reject = abort per spec §3.5).

### Step 5.4 — Run test, verify GREEN

- [ ] **Step 5.4**: Run.

Run: `CI=true npx vitest run src/__tests__/unit/quick-impl-bootstrap-topology.test.ts`

Expected: 4 tests pass.

### Step 5.5 — Typecheck

- [ ] **Step 5.5**: Run.

Run: `pnpm exec tsc --noEmit`

Expected: silent.

### Step 5.6 — Commit

- [ ] **Step 5.6**: Commit.

```bash
git add src/quick-impl/bootstrap.ts src/__tests__/unit/quick-impl-bootstrap-topology.test.ts
git commit -m "feat(bootstrap): v16 — spec/plan/dev_human_gate.retryToOnReject

reject 决策触发 retryFromNode 重写对应 author 节点：
- spec_human_gate.retryToOnReject = 'spec_author'
- plan_human_gate.retryToOnReject = 'plan_author'
- dev_human_gate.retryToOnReject = 'dev_author'
- final_approval **不配** — reject = abort 语义（spec §3.5）

QUICK_IMPL_TEMPLATE_VERSION 15 → 16 让 bootstrap reseed DB pipeline.graph。"
```

---

## Task 6: 前端决策下拉 disable reject

**Files:**
- Modify: [web/src/pages/requirements-helpers.ts](../../../web/src/pages/requirements-helpers.ts) — 加 `buildDecisionOptions` helper
- Modify: [web/src/pages/RequirementsPage.tsx:1194-1212](../../../web/src/pages/RequirementsPage.tsx#L1194-L1212) — Select options 接 helper
- Test: [web/src/pages/requirements-helpers.test.ts](../../../web/src/pages/requirements-helpers.test.ts) — extend

**Covers AC-6/7 — 前端 UI 显示 reject disabled + 仍可 force/abort/approve.**

### Step 6.1 — Write failing tests

- [ ] **Step 6.1**: Append to [web/src/pages/requirements-helpers.test.ts](../../../web/src/pages/requirements-helpers.test.ts):

```typescript
import { describe, it, expect } from 'vitest'
import { buildDecisionOptions, REJECT_CAP } from './requirements-helpers'
import type { ApprovalWaiterDTO } from '../api/requirements'

const baseW: ApprovalWaiterDTO = {
  id: 1, requirementId: 7, pipelineRunId: 100, nodeId: 'spec_human_gate',
  approvalKind: 'spec', round: 1, decisionSet: 'human_gate', imPlatform: null, imGroupId: null,
  contextSummary: null, claimedBy: null, claimedAt: null, decision: null, rejectReason: null,
  budgetDelta: null, decidedBy: null, createdAt: '2026-05-12T00:00:00Z',
}

describe('buildDecisionOptions — reject disable when cap exhausted', () => {
  it('count=0 → reject 可用', () => {
    const opts = buildDecisionOptions(baseW, { reject_counts: { spec_human_gate: 0 } })
    const reject = opts.find(o => o.value === 'rejected')
    expect(reject?.disabled).toBeFalsy()
    expect(reject?.label).toContain('要求修改')
  })

  it('count=3 → reject disabled + label 含"已达上限"', () => {
    const opts = buildDecisionOptions(baseW, { reject_counts: { spec_human_gate: 3 } })
    const reject = opts.find(o => o.value === 'rejected')
    expect(reject?.disabled).toBe(true)
    expect(reject?.label).toContain('已达')
    expect(reject?.label).toContain('上限')
  })

  it('count=3 → approved / force_passed / aborted 仍可用', () => {
    const opts = buildDecisionOptions(baseW, { reject_counts: { spec_human_gate: 3 } })
    const enabled = opts.filter(o => !o.disabled).map(o => o.value)
    expect(enabled).toContain('approved')
    expect(enabled).toContain('force_passed')
    expect(enabled).toContain('aborted')
    expect(enabled).toContain('budget_extended')
  })

  it('plan_human_gate 独立计数（spec_human_gate.count=3 不影响 plan_human_gate）', () => {
    const planW = { ...baseW, nodeId: 'plan_human_gate', approvalKind: 'plan' as const }
    const opts = buildDecisionOptions(planW, { reject_counts: { spec_human_gate: 3, plan_human_gate: 0 } })
    const reject = opts.find(o => o.value === 'rejected')
    expect(reject?.disabled).toBeFalsy()
  })

  it('REJECT_CAP 常量导出值 = 3', () => {
    expect(REJECT_CAP).toBe(3)
  })

  it('plan_escalation decisionSet → 走老 4-way 分支（不被 reject disable 影响）', () => {
    const planEscW = { ...baseW, decisionSet: 'plan_escalation' as const }
    const opts = buildDecisionOptions(planEscW, { reject_counts: { spec_human_gate: 3 } })
    // 4 个 plan_escalation 决策
    const values = opts.map(o => o.value)
    expect(values).toContain('rejected_plan')
    expect(values).toContain('rejected_spec')
    // 不应有普通 'rejected'
    expect(values).not.toContain('rejected')
  })
})
```

### Step 6.2 — Run test, verify RED

- [ ] **Step 6.2**: Run.

```bash
cd /Users/zhangshanshan/AI-ChatOps/web && npx vitest run src/pages/requirements-helpers.test.ts
```

Expected: 6 new tests fail — `buildDecisionOptions is not a function` / `REJECT_CAP is not exported`.

### Step 6.3 — Implement `buildDecisionOptions` helper

- [ ] **Step 6.3**: Append to [web/src/pages/requirements-helpers.ts](../../../web/src/pages/requirements-helpers.ts):

```typescript
/**
 * Reject reroute 上限（与后端 graph-builder.ts REJECT_CAP 保持一致）。
 * 达上限后决策下拉 reject 选项 disabled，引导用户选 force_passed / aborted / approved。
 */
export const REJECT_CAP = 3

export interface DecisionOption {
  value: string
  label: string
  disabled?: boolean
}

/**
 * 构造决策下拉选项。
 * - waiter.decisionSet='plan_escalation' → 4-way plan escalation 老分支（不受 reject cap 影响）
 * - 其他（含 'human_gate' / 'binary'）→ 5 选项，其中 'rejected' 在 reject_counts[nodeId] ≥ REJECT_CAP 时 disable
 */
export function buildDecisionOptions(
  waiter: ApprovalWaiterDTO | null | undefined,
  retryCounters: { reject_counts?: Record<string, number> } | null | undefined,
): DecisionOption[] {
  if (!waiter) return []

  if (waiter.decisionSet === 'plan_escalation') {
    return [
      { value: 'approved',       label: '✅ 通过（plan 可用，AI 抠的是 nitpick）' },
      { value: 'rejected_plan',  label: '❌ 拒绝 plan（让 plan-decomposer 重拆）' },
      { value: 'rejected_spec',  label: '⛔ 拒绝 spec（spec 本身有问题，需手工重新提交需求）' },
      { value: 'aborted',        label: '🛑 终止（说不准 / 不该 AI 拆）' },
    ]
  }

  const rejectCount = retryCounters?.reject_counts?.[waiter.nodeId] ?? 0
  const rejectExhausted = rejectCount >= REJECT_CAP

  return [
    { value: 'approved',        label: '✅ 通过' },
    {
      value: 'rejected',
      label: rejectExhausted
        ? `❌ 拒绝（已达 ${REJECT_CAP} 轮上限，请选下方其它）`
        : '❌ 拒绝（要求修改）',
      disabled: rejectExhausted,
    },
    { value: 'force_passed',    label: '⚡ 强制通过（跳过评审）' },
    { value: 'budget_extended', label: '⏳ 延期（追加预算）' },
    { value: 'aborted',         label: '🛑 中止需求' },
  ]
}
```

### Step 6.4 — Wire `buildDecisionOptions` into `RequirementsPage.tsx`

- [ ] **Step 6.4**: In [web/src/pages/RequirementsPage.tsx](../../../web/src/pages/RequirementsPage.tsx), update the import line:

Find:
```typescript
import { findStageForWaiter, shouldWarnPlanRework, KIND_LABEL, buildDecisionModalTitle } from './requirements-helpers'
```

Replace with:
```typescript
import { findStageForWaiter, shouldWarnPlanRework, KIND_LABEL, buildDecisionModalTitle, buildDecisionOptions } from './requirements-helpers'
```

Then find lines around [1194-1212](../../../web/src/pages/RequirementsPage.tsx#L1194-L1212) — the `<Select options={...} />` block. Replace the entire `options={...}` prop with:

```tsx
<Select
  options={buildDecisionOptions(
    decideState.waiter,
    detail?.retryCounters as { reject_counts?: Record<string, number> } | null,
  )}
/>
```

### Step 6.5 — Run test, verify GREEN

- [ ] **Step 6.5**: Run.

```bash
cd /Users/zhangshanshan/AI-ChatOps/web && npx vitest run src/pages/requirements-helpers.test.ts
```

Expected: all tests pass (24 existing + 6 new = 30).

### Step 6.6 — Frontend typecheck

- [ ] **Step 6.6**: Run.

```bash
cd /Users/zhangshanshan/AI-ChatOps/web && pnpm exec tsc --noEmit
```

Expected: silent.

### Step 6.7 — Commit

- [ ] **Step 6.7**: Commit.

```bash
git add web/src/pages/requirements-helpers.ts web/src/pages/requirements-helpers.test.ts web/src/pages/RequirementsPage.tsx
git commit -m "feat(web): 决策下拉 reject 选项达 cap=3 时 disable

新 buildDecisionOptions helper（可测）；REJECT_CAP=3 常量与后端一致。
plan_escalation 4-way 老分支不受影响。

spec §3.6 / AC-6/7。"
```

---

## Task 7: 全链路集成测（reject round 2 + approve happy path + cap exhausted）

**Files:**
- Test: [src/__tests__/integration/qi-reject-round2.integration.test.ts](../../../src/__tests__/integration/qi-reject-round2.integration.test.ts) (new — DB-dependent)

**Covers AC-1/2/4/5 + e2e 5.1/5.2/5.3.**

### Step 7.1 — Write failing integration test

- [ ] **Step 7.1**: Create [src/__tests__/integration/qi-reject-round2.integration.test.ts](../../../src/__tests__/integration/qi-reject-round2.integration.test.ts):

```typescript
/**
 * Integration test: reject 拓扑 + round-2 重写机制
 *
 * Verifies:
 *   - reject → retry_counters.reject_counts++ + last_reject_reasons 写入
 *   - cap=3 边界
 *   - approved 路径不触发 reject 计数
 *
 * NOT verified here (留 manual E2E)：
 *   - retryFromNode 真重起 graph stream（依赖 LangGraph runtime）
 *   - skill-runner feedback.md 真写入（依赖 worktree fs）
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { resetTestDb } from '../helpers/db.js'
import {
  createRequirement,
  getRejectCount,
  incrementRejectCount,
  getLastRejectReason,
} from '../../db/repositories/requirements.js'
import { REJECT_CAP } from '../../pipeline/graph-builder.js'

describe('reject reroute integration', () => {
  let reqId: number

  beforeAll(async () => { await resetTestDb() })

  beforeEach(async () => {
    const r = await createRequirement({
      title: 'integration test', rawInput: 'x', gitlabProject: 'g/p', source: 'web', status: 'draft',
    })
    reqId = r.id
  })

  it('e2e 5.2: reject round 1 → reject_counts=1 + reason 入 last_reject_reasons', async () => {
    expect(await getRejectCount(reqId, 'spec_human_gate')).toBe(0)
    
    await incrementRejectCount({
      requirementId: reqId, humanGateNodeId: 'spec_human_gate', authorNodeId: 'spec_author',
      rejectReason: 'AC 不够具体，缺边界条件',
    })
    
    expect(await getRejectCount(reqId, 'spec_human_gate')).toBe(1)
    expect(await getLastRejectReason(reqId, 'spec_author')).toBe('AC 不够具体，缺边界条件')
  })

  it('e2e 5.3: 连续 3 次 reject → reject_counts=3 = REJECT_CAP', async () => {
    for (let i = 1; i <= REJECT_CAP; i++) {
      await incrementRejectCount({
        requirementId: reqId, humanGateNodeId: 'spec_human_gate', authorNodeId: 'spec_author',
        rejectReason: `round ${i} reject reason`,
      })
      expect(await getRejectCount(reqId, 'spec_human_gate')).toBe(i)
    }
    
    expect(await getRejectCount(reqId, 'spec_human_gate')).toBe(REJECT_CAP)
    expect(await getLastRejectReason(reqId, 'spec_author')).toBe(`round ${REJECT_CAP} reject reason`)
  })

  it('e2e 5.1: 不调 increment → reject_counts 保持 0（approved 路径不污染）', async () => {
    // 模拟 approved 路径：从未调 incrementRejectCount
    expect(await getRejectCount(reqId, 'spec_human_gate')).toBe(0)
    expect(await getLastRejectReason(reqId, 'spec_author')).toBeNull()
  })

  it('多阶段独立：spec reject 不影响 plan 计数（反之亦然）', async () => {
    await incrementRejectCount({
      requirementId: reqId, humanGateNodeId: 'spec_human_gate', authorNodeId: 'spec_author',
      rejectReason: 'spec reason',
    })
    
    expect(await getRejectCount(reqId, 'plan_human_gate')).toBe(0)
    expect(await getRejectCount(reqId, 'dev_human_gate')).toBe(0)
    expect(await getLastRejectReason(reqId, 'plan_author')).toBeNull()
    expect(await getLastRejectReason(reqId, 'dev_author')).toBeNull()
  })

  it('REJECT_CAP 后端常量值 = 3', () => {
    expect(REJECT_CAP).toBe(3)
  })
})
```

### Step 7.2 — Run integration test

- [ ] **Step 7.2**: Run.

```bash
CI=true npx vitest run src/__tests__/integration/qi-reject-round2.integration.test.ts
```

If Docker available (testcontainer), use without `CI=true`:

```bash
npx vitest run src/__tests__/integration/qi-reject-round2.integration.test.ts
```

Expected: 5 tests pass. CI=true mode requires external DATABASE_URL with already-applied schema.

### Step 7.3 — Commit

- [ ] **Step 7.3**: Commit.

```bash
git add src/__tests__/integration/qi-reject-round2.integration.test.ts
git commit -m "test(qi): reject 拓扑 round-2 重写集成测

覆盖 reject_counts 累加 / last_reject_reasons 覆盖 / 多阶段独立 / 
approved 路径不污染计数 / REJECT_CAP=3 边界。

retryFromNode 真重起 stream 留 manual E2E（spec §5.1-5.4）。"
```

---

## Task 8: 收尾验证 + manual E2E

**Files:** none (verification only)

### Step 8.1 — Full backend test + typecheck

- [ ] **Step 8.1**: Run.

```bash
pnpm exec tsc --noEmit && \
CI=true npx vitest run \
  src/__tests__/unit/requirements-retry-counters.test.ts \
  src/__tests__/unit/human-gate-reject-reroute.test.ts \
  src/__tests__/unit/llm-author-previous-round.test.ts \
  src/__tests__/unit/quick-impl-bootstrap-topology.test.ts \
  src/__tests__/integration/qi-reject-round2.integration.test.ts
```

Expected: all pass + tsc silent.

### Step 8.2 — Full frontend test + typecheck

- [ ] **Step 8.2**: Run.

```bash
cd /Users/zhangshanshan/AI-ChatOps/web && \
pnpm exec tsc --noEmit && \
npx vitest run src/pages/requirements-helpers.test.ts
```

Expected: all pass + tsc silent.

### Step 8.3 — Manual E2E (用户做，不强制 — AC 已由测试覆盖)

- [ ] **Step 8.3**: 用户重启后端后：

1. 新建需求 → 等到 spec_human_gate round 1 → verify contextSummary 是 4840 字符版（v15 fix 不回归）
2. 决策选 "❌ 拒绝（要求修改）"，rejectReason="测试 round 2"
3. 等 ~60s → 应看到新 waiter 出现 + `round=2` + contextSummary 不同于 round 1（spec.md 被 spec-author 改了）
4. 再 reject 一次 → round=3 waiter
5. 再 reject 一次 → reject_counts.spec_human_gate=3 → 进入 spec_human_gate 第 4 次时 stage 标 failed + onFailure='stop' halt
6. 在 Web 详情页打开决策弹窗，验：reject 下拉项 disabled + 文案 "已达 3 轮上限"
7. 选 force_passed / approved → 验证仍能 claim 成功 → pipeline 继续
8. abort 清理

如步骤 2 失败（waiter.contextSummary 未变 / 仍 round=1），说明 retryFromNode 没真重起 graph — 查 backend log + `setRequirementStatus / retry_counters` 状态。

---

## NoGos（来自 spec §7）

- 不改 LangGraph cycle 边（用 app-level retryFromNode）
- 不动 final_approval 节点函数 — 缺 retryToOnReject 自然走老路径
- 不破坏 budget_extended 决策（保留现状，与 reject 解耦）
- 不修改 retryFromNode 接口（不加 previousRound 入参，状态通过 retry_counters 传）
- 不动 skill-runner 已有的 previousRound / feedback.md 机制
