/**
 * AC6: reanalyze 决策
 * - L3 审批 decision='retry_analysis' → coordinator onComplete 自动调 handleAnalyzeBug with reuseIssueId=原 issueId
 * - 产生新 report，issue_id 相同
 * - 新 report 的 create_issue 事件 isReused=true
 */
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest'

vi.mock('../../agent/analysis/claude-runs.js', async () => {
  const actual = await vi.importActual<typeof import('../../agent/analysis/claude-runs.js')>(
    '../../agent/analysis/claude-runs.js',
  )
  return {
    ...actual,
    runFilterStage: vi.fn(),
    runDetailStage: vi.fn(),
  }
})

vi.mock('../../agent/analysis/gitlab-issue.js', () => ({
  gitlabCreateIssue: vi.fn(),
  gitlabPostIssueNote: vi.fn(),
}))

vi.mock('../../agent/fix/fix-logic.js', async () => {
  const actual = await vi.importActual<typeof import('../../agent/fix/fix-logic.js')>(
    '../../agent/fix/fix-logic.js',
  )
  return {
    ...actual,
    runFixForProject: vi.fn(),
  }
})

vi.mock('../../agent/mr/gitlab-mr.js', () => ({
  gitlabCreateMr: vi.fn(),
}))

vi.mock('../../agent/review/claude-review.js', () => ({
  runClaudeReview: vi.fn(),
}))

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

import { resetTestDb } from '../helpers/db.js'
import { baseSeed, seedProject } from '../helpers/bug-fix-seed.js'
import { registerAnalysisBugHandler } from '../../agent/analysis/analyzer.js'
import { handleAnalyzeBug } from '../../agent/analysis/analyzer.js'
import { handleAnalysisComplete, registerCapabilityHandler } from '../../agent/coordinator.js'
import { handleFixBug } from '../../agent/fix/fix-runner.js'
import { handleCreateMr } from '../../agent/mr/mr-handler.js'
import { handleReviewMr } from '../../agent/review/reviewer.js'
import { handleNotify } from '../../agent/notify/notify-handler.js'
import { handleApproveL3 } from '../../agent/approval/approve-l3-handler.js'
import {
  getBugAnalysisReportById,
  listReportsByProductLine,
} from '../../db/repositories/bug-analysis-reports.js'
import { findByReportCode } from '../../db/repositories/bug-fix-events.js'
import { PipelineApprovalManager } from '../../pipeline/approval-manager.js'

import { runFilterStage, runDetailStage } from '../../agent/analysis/claude-runs.js'
import { gitlabCreateIssue, gitlabPostIssueNote } from '../../agent/analysis/gitlab-issue.js'
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

describe('AC6: reanalyze 决策 → 新一轮分析', () => {
  let productLineId: number
  let mockAdapter: IMAdapter & { sendDirectMessage: ReturnType<typeof vi.fn> }

  beforeAll(() => {
    registerCapabilityHandler('fix_bug_l3', opts => handleFixBug(opts, 'l3'))
    registerCapabilityHandler('approve_l3', handleApproveL3)
    registerCapabilityHandler('create_mr', handleCreateMr)
    registerCapabilityHandler('ai_review_mr', handleReviewMr)
    registerCapabilityHandler('notify_bug', handleNotify)
    registerAnalysisBugHandler() // 注册 analyze_bug handler，供 coordinator 的 retry_analysis 分支调用
  })

  beforeEach(async () => {
    await resetTestDb()
    vi.clearAllMocks()

    const seed = await baseSeed()
    productLineId = seed.productLineId
    await seedProject(productLineId, {
      name: 'pas-api',
      gitlabPath: 'PAM/pas-api',
      ownerId: 'u-primary',
      ownerName: '主负责人',
    })

    mockAdapter = makeMockAdapter()
    PipelineApprovalManager.initialize([mockAdapter])

    ;(runFilterStage as any).mockResolvedValue({
      involvedProjects: [{ projectPath: 'PAM/pas-api', isPrimary: true, sourceBranch: 'test' }],
      primaryProjectPath: 'PAM/pas-api',
    })
    ;(runDetailStage as any).mockResolvedValue({
      classification: 'bug',
      level: 'l3',
      confidence: 'medium',
      confidenceScore: 0.7,
      rootCause: { type: 'logic', summary: 'L3 业务 bug', file: 'x.java', lineRange: [1, 10] },
      solutions: [{ id: 'a', summary: '改业务', recommended: true, risk: 'medium', effort: 'medium' }],
      affectedModules: ['auth'],
      analysisSteps: ['读代码'],
      markdown: '# L3 分析',
    })
    ;(gitlabCreateIssue as any).mockResolvedValue({
      iid: 66,
      url: 'http://git.example.com/PAM/pas-api/-/issues/66',
    })
    ;(gitlabPostIssueNote as any).mockResolvedValue({
      issueUrl: 'http://git.example.com/PAM/pas-api/-/issues/66',
    })
  })

  it('approval decision=retry_analysis → 触发新 analyze_bug 且 issue_id 相同', async () => {
    // 第一次审批返回 retry_analysis，触发 coordinator 内部自动重新分析
    vi.spyOn(PipelineApprovalManager.prototype, 'requestApproval').mockResolvedValue('retry_analysis')

    const analyzerResult = await handleAnalyzeBug({
      capabilityKey: 'analyze_bug',
      context: { taskId: 't', groupId: 'g', platform: 'test', initiatorId: 'u-trigger', initiatorRole: 'developer' },
      extraParams: { productLineId, message: 'L3 bug' },
    })
    expect(analyzerResult.success).toBe(true)
    const firstReportId = (analyzerResult.data as any).reportId as number

    // 启动 pipeline（审批会返回 retry_analysis，Pipeline failed）
    await handleAnalysisComplete(firstReportId, 'l3', 'bug', 'u-trigger')

    const first = await getBugAnalysisReportById(firstReportId)
    expect(first!.status).toBe('aborted')
    expect(first!.issueId).toBe(66)

    // coordinator onComplete 在 failed 分支检查 decision='retry_analysis' → 自动触发 analyze_bug
    // 等 reanalyze 的异步链路完成
    await new Promise(r => setTimeout(r, 100))

    // 产生第二个 report，issue_id 相同
    const reports = await listReportsByProductLine(productLineId, 10)
    expect(reports.length).toBeGreaterThanOrEqual(2)
    const newReport = reports.find(r => r.id !== firstReportId)
    expect(newReport).toBeTruthy()
    expect(newReport!.issueId).toBe(66) // 复用同一 Issue

    // 新 report 的 create_issue 事件 isReused=true
    const createIssueEvents = await findByReportCode(newReport!.id, 'create_issue')
    expect(createIssueEvents).toHaveLength(1)
    expect((createIssueEvents[0].data as any).isReused).toBe(true)

    // gitlabPostIssueNote 被调（复用 Issue 走 note 路径）
    expect(gitlabPostIssueNote).toHaveBeenCalled()
    // gitlabCreateIssue 仅在第一次被调（第二次是 reuse → Note）
    expect(gitlabCreateIssue).toHaveBeenCalledTimes(1)
  }, 30_000)
})
