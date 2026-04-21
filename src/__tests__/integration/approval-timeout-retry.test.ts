/**
 * AC3: L3 审批 timeout → aborted（graph-runner approval stage 版本）
 *
 * 新架构下 timeout 机制：graph-runner 的 dispatchInterrupt 在 approval 触发时
 * 用 scheduleTimeout(stage.timeoutSeconds * 1000, new Command({resume:'timeout'}))
 * 调度超时自动 resume。spec 里把 pipeline L3 approval stage 的 timeoutSeconds
 * 降到 1 秒触发快速超时，等 2.5 秒后断言 pipeline 进入 aborted 终态。
 *
 * 注：老版的 "retry endpoint 复用 Issue 新 Pipeline" 断言已拆到
 * admin-bug-reports.test.ts 的 /retry endpoint 单元测试，这里不重复。
 */
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest'

vi.mock('../../agent/analysis/claude-runs.js', async () => {
  const actual = await vi.importActual<typeof import('../../agent/analysis/claude-runs.js')>(
    '../../agent/analysis/claude-runs.js',
  )
  return { ...actual, runFilterStage: vi.fn(), runDetailStage: vi.fn() }
})

vi.mock('../../agent/analysis/gitlab-issue.js', () => ({
  gitlabCreateIssue: vi.fn(),
  gitlabPostIssueNote: vi.fn(),
  gitlabUpdateIssue: vi.fn(),
  gitlabGetIssue: vi.fn(),
}))

vi.mock('../../agent/fix/fix-logic.js', async () => {
  const actual = await vi.importActual<typeof import('../../agent/fix/fix-logic.js')>(
    '../../agent/fix/fix-logic.js',
  )
  return { ...actual, runFixForProject: vi.fn() }
})

vi.mock('../../agent/mr/gitlab-mr.js', () => ({ gitlabCreateMr: vi.fn() }))
vi.mock('../../agent/review/claude-review.js', () => ({ runClaudeReview: vi.fn() }))
vi.mock('../../agent/review/gitlab-mr-note.js', () => ({
  gitlabPostMrNote: vi.fn().mockResolvedValue(undefined),
  gitlabUpdateMrLabels: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../agent/worktree/manager.js', async () => {
  const actual = await vi.importActual<typeof import('../../agent/worktree/manager.js')>(
    '../../agent/worktree/manager.js',
  )
  return {
    ...actual,
    acquire: vi.fn(async () => ({
      id: 'wt', path: '/tmp/wt', key: 'k', createdAt: new Date(),
    })),
    release: vi.fn(),
    makeWorktreeKey: vi.fn(() => 'k'),
  }
})

import { resetTestDb, getTestPool } from '../helpers/db.js'
import { baseSeed, seedProject } from '../helpers/bug-fix-seed.js'
import { handleAnalyzeBug } from '../../agent/analysis/analyzer.js'
import { handleAnalysisComplete, registerCapabilityHandler } from '../../agent/coordinator.js'
import { handleCreateMr } from '../../agent/mr/mr-handler.js'
import { handleFixBug } from '../../agent/fix/fix-runner.js'
import { handleReviewMr } from '../../agent/review/reviewer.js'
import { handleNotify } from '../../agent/notify/notify-handler.js'
import { getBugAnalysisReportById } from '../../db/repositories/bug-analysis-reports.js'
import { PipelineApprovalManager } from '../../pipeline/approval-manager.js'
import { initGraphRunnerDispatchers } from '../../pipeline/graph-runner.js'
import { resetCheckpointerForTesting } from '../../pipeline/graph-runtime.js'
import { registerBuiltinApprovalResolvers } from '../../agent/approval/resolvers.js'

import { runFilterStage, runDetailStage } from '../../agent/analysis/claude-runs.js'
import { gitlabCreateIssue } from '../../agent/analysis/gitlab-issue.js'
import type { IMAdapter } from '../../adapters/im/types.js'

function makeMockAdapter(): IMAdapter & { sendDirectMessage: ReturnType<typeof vi.fn> } {
  const fn = vi.fn().mockResolvedValue(undefined)
  return {
    platform: 'dingtalk',
    onMessage: vi.fn(),
    sendMessage: vi.fn(),
    sendCard: vi.fn(),
    sendDirectMessage: fn,
    getUserInfo: vi.fn(),
    onCardAction: vi.fn(),
    handleWebhook: vi.fn(),
  } as unknown as IMAdapter & { sendDirectMessage: ReturnType<typeof vi.fn> }
}

describe('AC3: L3 审批超时 → aborted', () => {
  let productLineId: number
  let mockAdapter: IMAdapter & { sendDirectMessage: ReturnType<typeof vi.fn> }

  beforeAll(() => {
    registerCapabilityHandler('fix_bug_l1', opts => handleFixBug(opts, 'l1'))
    registerCapabilityHandler('fix_bug_l2', opts => handleFixBug(opts, 'l2'))
    registerCapabilityHandler('fix_bug_l3', opts => handleFixBug(opts, 'l3'))
    registerCapabilityHandler('create_mr', handleCreateMr)
    registerCapabilityHandler('ai_review_mr', handleReviewMr)
    registerCapabilityHandler('notify_bug', handleNotify)
    registerBuiltinApprovalResolvers()
  })

  beforeEach(async () => {
    await resetTestDb()
    resetCheckpointerForTesting()
    vi.clearAllMocks()

    const seed = await baseSeed()
    productLineId = seed.productLineId
    await seedProject(productLineId, {
      name: 'pas-api', gitlabPath: 'PAM/pas-api',
      ownerId: 'u-primary', ownerName: '主负责人',
    })

    // 把 L3 pipeline approval stage 的 timeoutSeconds 改小（1s），触发快速超时
    await getTestPool().query(
      `UPDATE test_pipelines
         SET stages = (
           SELECT jsonb_agg(
             CASE WHEN (s->>'stageType') = 'approval'
                  THEN jsonb_set(s, '{timeoutSeconds}', to_jsonb(1))
                  ELSE s END
           )
           FROM jsonb_array_elements(stages) s
         )
       WHERE product_line_id = $1 AND name = 'L3-业务逻辑'`,
      [productLineId],
    )

    mockAdapter = makeMockAdapter()
    PipelineApprovalManager.initialize([mockAdapter])
    initGraphRunnerDispatchers()

    ;(runFilterStage as any).mockResolvedValue({
      involvedProjects: [{ projectPath: 'PAM/pas-api', isPrimary: true, sourceBranch: 'test' }],
      primaryProjectPath: 'PAM/pas-api',
    })
    ;(runDetailStage as any).mockResolvedValue({ kind: 'detail', detail: {
      classification: 'bug', level: 'l3',
      confidence: 'medium', confidenceScore: 0.7,
      rootCause: { type: 'logic', summary: 'L3 业务 bug', file: 'x.java', lineRange: [1, 10] },
      solutions: [{ id: 'a', summary: '改业务', recommended: true, risk: 'medium', effort: 'medium' }],
      affectedModules: ['auth'],
      analysisSteps: ['读代码'],
      markdown: '# L3 分析',
    }})
    ;(gitlabCreateIssue as any).mockResolvedValue({
      iid: 77,
      url: 'http://git.example.com/PAM/pas-api/-/issues/77',
    })
  })

  afterEach(async () => {
    await new Promise(r => setTimeout(r, 300))
    vi.restoreAllMocks()
  })

  it('approval 在 stage.timeoutSeconds 内没被 resume → graph-runner 自动触发 timeout → pipeline aborted', async () => {
    // spy requestCard（不真发钉钉卡片，模拟"没人点按钮"场景）
    vi
      .spyOn(PipelineApprovalManager.prototype, 'requestCard')
      .mockResolvedValue('mock-approval-id')

    const analyzerResult = await handleAnalyzeBug({
      capabilityKey: 'analyze_bug',
      context: { taskId: 't', groupId: 'g', platform: 'test', initiatorId: 'u-trigger', initiatorRole: 'developer' },
      extraParams: { productLineId, message: 'L3 bug' },
    })
    expect(analyzerResult.success).toBe(true)
    const reportId = (analyzerResult.data as any).reportId

    await handleAnalysisComplete(reportId, 'l3', 'bug', 'u-trigger')

    // 等 graph-runner scheduleTimeout (stage.timeoutSeconds=1s) 触发
    // + pipeline 后续 failed path + coordinator.onComplete 把 status 改 aborted
    // 总共给 4s budget（1s timer + 3s 余量）
    let report = await getBugAnalysisReportById(reportId)
    const pollStart = Date.now()
    while (
      report?.status !== 'pipeline_success' &&
      report?.status !== 'aborted' &&
      Date.now() - pollStart < 4000
    ) {
      await new Promise(r => setTimeout(r, 100))
      report = await getBugAnalysisReportById(reportId)
    }

    expect(report!.status).toBe('aborted')
    // fix/MR/review 不应被调（pipeline 挂在 approval 没走到后续 stage）
    const fixLogic = await import('../../agent/fix/fix-logic.js')
    expect((fixLogic.runFixForProject as any)).not.toHaveBeenCalled()
  }, 30_000)
})
