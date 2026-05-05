// src/__tests__/unit/await-human-review.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { PipelineBStateType } from '../../e2e/pipeline-b/types.js'
import type { Manifest } from '../../e2e/pipeline-b/playbook/manifest.js'

vi.mock('../../db/repositories/e2e-runs.js', () => ({
  updateE2eRunStatus: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../pipeline/im-param-collector.js', () => ({
  waitForImMessage: vi.fn(),
}))

vi.mock('../../e2e/pipeline-b/im-notifier.js', () => ({
  notifyAwaitHumanReview: vi.fn().mockResolvedValue(undefined),
}))

const { awaitHumanReviewNode, parseDecision } = await import(
  '../../e2e/pipeline-b/nodes/await-human-review.js'
)
const { updateE2eRunStatus } = await import('../../db/repositories/e2e-runs.js')
const { waitForImMessage } = await import('../../pipeline/im-param-collector.js')
const { notifyAwaitHumanReview } = await import('../../e2e/pipeline-b/im-notifier.js')

const MANIFEST: Manifest = {
  scenarioId: 's1',
  attemptNumber: 1,
  result: 'fail',
  startedAt: '2026-05-05T10:00:00.000Z',
  finishedAt: '2026-05-05T10:00:30.000Z',
  durationMs: 30000,
  claudeTrace: [],
  acceptanceResults: [{ kind: 'url_match', index: 0, result: 'fail' }],
  artifacts: [],
}

function makeState(overrides: Partial<PipelineBStateType> = {}): PipelineBStateType {
  const adapter = { sendMessage: vi.fn() } as never
  return {
    runId: 7n,
    sandboxId: null,
    targetProjectId: 'chatops',
    sourceBranch: 'main',
    iterationBranch: '',
    scenarioFilter: null,
    sandboxHandle: null,
    projectScripts: { build: 'build.sh', deploy: 'deploy.sh', test: 'test.sh' },
    pendingScenarios: [],
    currentScenario: { id: 's1', name: 'S1', tags: [] },
    currentScenarioRunId: null,
    lastScenarioResult: 'fail',
    lastFixResult: null,
    evidenceDirTemp: null,
    humanReviewDecision: null,
    currentManifest: MANIFEST,
    playbooks: {},
    governorState: {
      perScenarioAttempts: {}, totalAttempts: 0, runStartedAt: 0, totalElapsedMs: 0,
      limits: { maxPerScenarioAttempts: 3, maxRunHours: 4, maxTotalAttempts: 30, maxQueuedRuns: 2 },
    },
    summaryMrUrl: null,
    errorMessage: null,
    imContext: { adapter, groupId: 'g1', platform: 'dingtalk' },
    ...overrides,
  } as PipelineBStateType
}

describe('parseDecision', () => {
  it.each([
    ['approve', 'approve'],
    ['Approve', 'approve'],
    ['批准', 'approve'],
    ['同意', 'approve'],
    ['修', 'approve'],
    ['yes', 'approve'],
    ['ok', 'approve'],
    ['确认', 'approve'],
    ['retry', 'retry'],
    ['重跑', 'retry'],
    ['再试', 'retry'],
    ['重试一下', 'retry'],
    ['reject', 'reject'],
    ['跳过', 'reject'],
    ['不修', 'reject'],
    ['拒绝', 'reject'],
    ['no', 'reject'],
    ['cancel', 'reject'],
    ['', 'reject'],
    ['乱码 xyz', 'reject'],
  ])('parseDecision(%j) → %s', (input, expected) => {
    expect(parseDecision(input)).toBe(expected)
  })
})

describe('awaitHumanReviewNode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(updateE2eRunStatus).mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('没 imContext → 立即返回 reject，不调 IM 通知/等待', async () => {
    const out = await awaitHumanReviewNode(makeState({ imContext: null }))
    expect(out.humanReviewDecision).toBe('reject')
    expect(vi.mocked(notifyAwaitHumanReview)).not.toHaveBeenCalled()
    expect(vi.mocked(waitForImMessage)).not.toHaveBeenCalled()
    expect(vi.mocked(updateE2eRunStatus)).not.toHaveBeenCalled()
  })

  it('没 currentManifest → reject', async () => {
    const out = await awaitHumanReviewNode(makeState({ currentManifest: null }))
    expect(out.humanReviewDecision).toBe('reject')
  })

  it('没 currentScenario → reject', async () => {
    const out = await awaitHumanReviewNode(makeState({ currentScenario: null }))
    expect(out.humanReviewDecision).toBe('reject')
  })

  it('用户回 approve → decision=approve，run status awaiting_human_review→running', async () => {
    vi.mocked(waitForImMessage).mockResolvedValue('approve')
    const out = await awaitHumanReviewNode(makeState())
    expect(out.humanReviewDecision).toBe('approve')

    const calls = vi.mocked(updateE2eRunStatus).mock.calls
    expect(calls[0]).toEqual([7n, 'awaiting_human_review'])
    expect(calls[1]).toEqual([7n, 'running'])
  })

  it('用户回 retry → decision=retry', async () => {
    vi.mocked(waitForImMessage).mockResolvedValue('重跑试试')
    const out = await awaitHumanReviewNode(makeState())
    expect(out.humanReviewDecision).toBe('retry')
  })

  it('用户回 reject 关键词 → decision=reject', async () => {
    vi.mocked(waitForImMessage).mockResolvedValue('跳过吧')
    const out = await awaitHumanReviewNode(makeState())
    expect(out.humanReviewDecision).toBe('reject')
  })

  it('IM 等待超时（waitForImMessage 抛错）→ decision=reject，run status 仍恢复 running', async () => {
    vi.mocked(waitForImMessage).mockRejectedValue(new Error('IM 等待消息超时'))
    const out = await awaitHumanReviewNode(makeState())
    expect(out.humanReviewDecision).toBe('reject')
    const calls = vi.mocked(updateE2eRunStatus).mock.calls
    expect(calls[1]).toEqual([7n, 'running'])
  })

  it('调 waitForImMessage 时使用 24h 超时（86400000ms）+ 正确的 platform/groupId', async () => {
    vi.mocked(waitForImMessage).mockResolvedValue('approve')
    await awaitHumanReviewNode(makeState())
    expect(vi.mocked(waitForImMessage)).toHaveBeenCalledWith('dingtalk', 'g1', 24 * 60 * 60 * 1000)
  })

  it('推送的通知含 manifest（notifyAwaitHumanReview 被调用一次）', async () => {
    vi.mocked(waitForImMessage).mockResolvedValue('approve')
    await awaitHumanReviewNode(makeState())
    expect(vi.mocked(notifyAwaitHumanReview)).toHaveBeenCalledOnce()
    const args = vi.mocked(notifyAwaitHumanReview).mock.calls[0]
    expect(args[1]).toBe('s1') // scenarioId
    expect(args[2]).toBe(MANIFEST)
  })
})
