// src/__tests__/unit/web-review-waiter.test.ts
//
// 覆盖 admin Web UI 触发的 e2e run 在 await_human_review 时的等待 / 决策路径。
// 不需要 DB（mock 掉 e2e-runs repo）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  waitForWebReviewDecision,
  submitWebReviewDecision,
  getPendingWebReview,
  _resetWebReviewWaitersForTest,
} from '../../e2e/pipeline-b/web-review-waiter.js'

vi.mock('../../db/repositories/e2e-runs.js', () => ({
  updateE2eRunStatus: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../pipeline/im-param-collector.js', () => ({
  waitForImMessage: vi.fn(),
}))

vi.mock('../im-notifier.js', () => ({
  notifyAwaitHumanReview: vi.fn().mockResolvedValue(undefined),
}), { virtual: true })

import { awaitHumanReviewNode } from '../../e2e/pipeline-b/nodes/await-human-review.js'
import { waitForImMessage } from '../../pipeline/im-param-collector.js'

describe('web-review-waiter', () => {
  beforeEach(() => {
    _resetWebReviewWaitersForTest()
  })

  afterEach(() => {
    _resetWebReviewWaitersForTest()
  })

  it('submit 后 wait promise resolve，对应 decision', async () => {
    const p = waitForWebReviewDecision(42n, 100n, 5_000)
    // 让 promise 注册完成（同步注册，但保险）
    await Promise.resolve()
    expect(getPendingWebReview(42n)).toEqual({ scenarioRunId: 100n })

    const r = submitWebReviewDecision(42n, 'approve')
    expect(r).toBe('submitted')
    await expect(p).resolves.toBe('approve')
    expect(getPendingWebReview(42n)).toBeNull()
  })

  it('没 waiter 时 submit 返回 no_waiter', () => {
    expect(submitWebReviewDecision(99n, 'reject')).toBe('no_waiter')
  })

  it('超时 reject', async () => {
    const p = waitForWebReviewDecision(42n, 100n, 50)
    await expect(p).rejects.toThrow(/timeout/)
    expect(getPendingWebReview(42n)).toBeNull()
  })

  it('对同 runId 重复注册时旧 waiter 被 superseded', async () => {
    const p1 = waitForWebReviewDecision(42n, 100n, 5_000)
    const p2 = waitForWebReviewDecision(42n, 200n, 5_000)
    await expect(p1).rejects.toThrow(/superseded/)
    submitWebReviewDecision(42n, 'retry')
    await expect(p2).resolves.toBe('retry')
  })
})

// awaitHumanReviewNode：无 imContext 时改走 web waiter（不再像旧版直接 reject）
describe('awaitHumanReviewNode (web review path)', () => {
  beforeEach(() => {
    _resetWebReviewWaitersForTest()
    vi.clearAllMocks()
  })

  afterEach(() => {
    _resetWebReviewWaitersForTest()
  })

  const baseState = {
    runId: 42n,
    sandboxId: null,
    targetProjectId: 'p',
    sourceBranch: 'main',
    iterationBranch: 'iter',
    scenarioFilter: null,
    sandboxHandle: null,
    projectScripts: { build: 'b', deploy: 'd', test: 't' },
    pendingScenarios: [],
    currentScenario: { id: 'login', name: 'L', tags: [] },
    currentScenarioRunId: 100n,
    lastScenarioResult: 'fail' as const,
    lastFixResult: null,
    evidenceDirTemp: null,
    humanReviewDecision: null,
    currentManifest: { result: 'fail' as const, scenarioId: 'login' },
    playbooks: {},
    governorState: {
      perScenarioAttempts: {},
      totalElapsedMs: 0,
      totalAttempts: 0,
      runStartedAt: Date.now(),
      limits: { maxPerScenarioAttempts: 3, maxRunHours: 4, maxTotalAttempts: 30, maxQueuedRuns: 2 },
    },
    summaryMrUrl: null,
    errorMessage: null,
    lastUnfixableScenario: null,
    imContext: null,
    playbookDraftId: undefined,
  }

  it('无 imContext + 等到 web 决策 approve → humanReviewDecision=approve', async () => {
    const nodePromise = awaitHumanReviewNode(baseState as never)
    // 让 node 注册 waiter
    await new Promise((r) => setTimeout(r, 5))
    const r = submitWebReviewDecision(42n, 'approve')
    expect(r).toBe('submitted')
    const result = await nodePromise
    expect(result.humanReviewDecision).toBe('approve')
    // 不应调用 IM waitForImMessage（那是另一条路径）
    expect(waitForImMessage).not.toHaveBeenCalled()
  })

  it('无 imContext + 等到 web 决策 reject → humanReviewDecision=reject', async () => {
    const nodePromise = awaitHumanReviewNode(baseState as never)
    await new Promise((r) => setTimeout(r, 5))
    submitWebReviewDecision(42n, 'reject')
    const result = await nodePromise
    expect(result.humanReviewDecision).toBe('reject')
  })

  it('缺 manifest/scenario/scenarioRunId → 兜底 reject 且不挂 waiter', async () => {
    const result = await awaitHumanReviewNode({
      ...baseState,
      currentManifest: null,
    } as never)
    expect(result.humanReviewDecision).toBe('reject')
    expect(getPendingWebReview(42n)).toBeNull()
  })
})
