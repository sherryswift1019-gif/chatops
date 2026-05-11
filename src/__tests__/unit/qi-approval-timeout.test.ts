/**
 * scheduleQiApprovalTimeout — human_gate timeout 接线单测。
 *
 * 不启 LangGraph、不连 DB；mock 掉 claimWaiter / resumeFromQiApproval 流程的
 * DB 依赖，直接调 exported scheduleQiApprovalTimeout 后等 timer fire，断言：
 *   - timeout 触发后调 claimWaiter(waiterId, 'timeout', { decision: ... })
 *   - claim 成功 → 调 resumeRun (via resumeFromQiApproval)
 *   - claim 失败（被人审先 claim）→ 不调 resumeRun
 *   - onTimeout='approve' → decision='approved'；'reject' → 'rejected'
 *   - clearQiApprovalTimer 通过 resumeFromQiApproval 入口 hook：模拟 IM 先到时
 *     timer 不再 fire
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// --- DB layer mocks (must be hoisted) ---------------------------------------

const mocks = vi.hoisted(() => ({
  claimWaiter: vi.fn(),
  getWaiterById: vi.fn(),
  pending: new Map<number, { runId: number; loopState: unknown }>(),
}))

vi.mock('../../db/repositories/requirement-approval-waiters.js', () => ({
  claimWaiter: mocks.claimWaiter,
  getWaiterById: mocks.getWaiterById,
}))

// Stub out heavy modules that graph-runner pulls in transitively.
vi.mock('../../pipeline/graph-runtime.js', () => ({
  getCheckpointer: vi.fn(),
  resetCheckpointerForTesting: vi.fn(),
}))
vi.mock('../../quick-impl/skill-executor.js', () => ({
  createProductionSkillExecutor: vi.fn(),
}))
vi.mock('../../pipeline/approval-manager.js', () => ({
  PipelineApprovalManager: { getInstance: () => ({ setResumeHandler: vi.fn() }) },
}))
vi.mock('../../pipeline/webhook-waiter.js', () => ({
  WebhookWaiter: { getInstance: () => ({ setResumeHandler: vi.fn(), register: vi.fn() }) },
}))
vi.mock('../../pipeline/qi-approval-manager.js', () => ({
  sendQiApprovalCard: vi.fn(async () => {}),
}))

vi.mock('../../pipeline/qi-approval-waiter.js', () => ({
  registerQiApprovalWaiter: (waiterId: number, info: { runId: number; loopState: unknown }) => {
    mocks.pending.set(waiterId, info)
  },
  getQiApprovalInfo: (waiterId: number) => mocks.pending.get(waiterId) ?? null,
  removeQiApprovalWaiter: (waiterId: number) => {
    mocks.pending.delete(waiterId)
  },
  clearQiApprovalWaitersByRunId: (runId: number) => {
    const removed: number[] = []
    for (const [waiterId, info] of mocks.pending) {
      if (info.runId === runId) removed.push(waiterId)
    }
    for (const w of removed) mocks.pending.delete(w)
    return removed
  },
  clearQiApprovalWaiters: () => {
    mocks.pending.clear()
  },
}))

import {
  scheduleQiApprovalTimeout,
  resetGraphRunnerForTesting,
  resumeFromQiApproval,
} from '../../pipeline/graph-runner.js'

beforeEach(() => {
  resetGraphRunnerForTesting()
  mocks.pending.clear()
  mocks.claimWaiter.mockReset()
  mocks.getWaiterById.mockReset()
  // Suppress noisy console.error in expected failure paths.
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('scheduleQiApprovalTimeout — human_gate timeout wiring', () => {
  it("claims waiter with decision='rejected' when onTimeout='reject'", async () => {
    const waiterId = 42
    mocks.pending.set(waiterId, { runId: 1, loopState: { budgetUsed: 0, rejectHistory: [] } })
    mocks.claimWaiter.mockResolvedValue({
      claimed: true,
      waiter: { id: waiterId, decision: 'rejected', claimedBy: 'timeout' },
    })

    scheduleQiApprovalTimeout(waiterId, 10, 'reject')
    // Wait for timer to fire + claim promise to resolve.
    await new Promise(r => setTimeout(r, 60))

    expect(mocks.claimWaiter).toHaveBeenCalledTimes(1)
    const [calledWaiterId, source, decisionInput] = mocks.claimWaiter.mock.calls[0]
    expect(calledWaiterId).toBe(waiterId)
    expect(source).toBe('timeout')
    expect(decisionInput.decision).toBe('rejected')
    expect(decisionInput.decidedBy).toBe('system:timeout')
    expect(decisionInput.rejectReason).toMatch(/timeout/)
  })

  it("claims waiter with decision='approved' when onTimeout='approve'", async () => {
    const waiterId = 43
    mocks.pending.set(waiterId, { runId: 1, loopState: { budgetUsed: 0, rejectHistory: [] } })
    mocks.claimWaiter.mockResolvedValue({
      claimed: true,
      waiter: { id: waiterId, decision: 'approved', claimedBy: 'timeout' },
    })

    scheduleQiApprovalTimeout(waiterId, 10, 'approve')
    await new Promise(r => setTimeout(r, 60))

    expect(mocks.claimWaiter).toHaveBeenCalledTimes(1)
    expect(mocks.claimWaiter.mock.calls[0][2].decision).toBe('approved')
    // approve 路径不该写 rejectReason —— 语义是拒绝原因，approve 时必须 null。
    expect(mocks.claimWaiter.mock.calls[0][2].rejectReason).toBeNull()
  })

  it('does NOT resume when human / IM has already claimed the waiter (claim race lost)', async () => {
    const waiterId = 44
    mocks.pending.set(waiterId, { runId: 1, loopState: { budgetUsed: 0, rejectHistory: [] } })
    // claim race lost: IM got there first
    mocks.claimWaiter.mockResolvedValue({ claimed: false, by: 'im' })

    scheduleQiApprovalTimeout(waiterId, 10, 'reject')
    await new Promise(r => setTimeout(r, 60))

    expect(mocks.claimWaiter).toHaveBeenCalledTimes(1)
    // Waiter info should still be in registry — resumeFromQiApproval was not
    // entered (no removeQiApprovalWaiter call on the claim-lost path).
    expect(mocks.pending.has(waiterId)).toBe(true)
  })

  it('clears the timer when resumeFromQiApproval fires (IM wins race before timer)', async () => {
    const waiterId = 45
    mocks.pending.set(waiterId, { runId: 1, loopState: { budgetUsed: 0, rejectHistory: [] } })

    // Schedule a timer that would otherwise fire in ~30ms.
    scheduleQiApprovalTimeout(waiterId, 30, 'reject')

    // Simulate IM callback path: human's claim succeeded externally, IM handler
    // calls resumeFromQiApproval with the claimed waiter row directly.
    const fakeClaimed = {
      id: waiterId,
      decision: 'approved',
      claimedBy: 'im',
      rejectReason: null,
      decidedBy: 'user:alice',
    } as never
    // resumeFromQiApproval will try to call resumeRun internally; that depends
    // on reloadContext which we haven't mocked — it'll fail but the failure
    // is swallowed by the .catch in resumeFromQiApproval. What matters is the
    // synchronous side effect: clearQiApprovalTimer + removeQiApprovalWaiter.
    await resumeFromQiApproval(waiterId, fakeClaimed)

    // Registry was cleared by resumeFromQiApproval.
    expect(mocks.pending.has(waiterId)).toBe(false)

    // Wait past the original timer's fire time; timer must not invoke claimWaiter.
    await new Promise(r => setTimeout(r, 60))
    expect(mocks.claimWaiter).not.toHaveBeenCalled()
  })

  it('rearming the same waiter replaces the old timer (idempotent)', async () => {
    const waiterId = 46
    mocks.pending.set(waiterId, { runId: 1, loopState: { budgetUsed: 0, rejectHistory: [] } })
    mocks.claimWaiter.mockResolvedValue({
      claimed: true,
      waiter: { id: waiterId, decision: 'rejected', claimedBy: 'timeout' },
    })

    // Schedule a long timer first.
    scheduleQiApprovalTimeout(waiterId, 5000, 'approve')
    // Replace with a short timer that should win.
    scheduleQiApprovalTimeout(waiterId, 10, 'reject')

    await new Promise(r => setTimeout(r, 60))

    // Only the short timer fired (one claim call, with the latest onTimeout).
    expect(mocks.claimWaiter).toHaveBeenCalledTimes(1)
    expect(mocks.claimWaiter.mock.calls[0][2].decision).toBe('rejected')
  })
})
