/**
 * AC3: L3 审批超时 → aborted → retry endpoint 复用 Issue → 新 Pipeline
 *
 * 1. L3 审批返回 timeout → Pipeline failed → report.status='aborted'
 * 2. 补发 notify_bug（coordinator onComplete 里自动调）
 * 3. 调 retry endpoint → 新 report，issueId 相同，触发新 Pipeline
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
import Fastify from 'fastify'
import { handleAnalyzeBug } from '../../agent/analysis/analyzer.js'
import { handleAnalysisComplete, registerCapabilityHandler } from '../../agent/coordinator.js'
import { handleCreateMr } from '../../agent/mr/mr-handler.js'
import { handleFixBug } from '../../agent/fix/fix-runner.js'
import { handleReviewMr } from '../../agent/review/reviewer.js'
import { handleNotify } from '../../agent/notify/notify-handler.js'
import { handleApproveL3 } from '../../agent/approval/approve-l3-handler.js'
import { registerAnalysisBugHandler } from '../../agent/analysis/analyzer.js'
import {
  getBugAnalysisReportById,
  listReportsByProductLine,
} from '../../db/repositories/bug-analysis-reports.js'
import { findByReport, findByReportCode } from '../../db/repositories/bug-fix-events.js'
import { PipelineApprovalManager } from '../../pipeline/approval-manager.js'
import { registerBugAnalysisReportRoutes } from '../../admin/routes/bug-analysis-reports.js'

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

describe('AC3: 审批超时 → aborted → retry 复用 Issue', () => {
  let productLineId: number
  let mockAdapter: IMAdapter & { sendDirectMessage: ReturnType<typeof vi.fn> }

  beforeAll(() => {
    registerCapabilityHandler('fix_bug_l1', opts => handleFixBug(opts, 'l1'))
    registerCapabilityHandler('fix_bug_l2', opts => handleFixBug(opts, 'l2'))
    registerCapabilityHandler('fix_bug_l3', opts => handleFixBug(opts, 'l3'))
    registerCapabilityHandler('approve_l3', handleApproveL3)
    registerCapabilityHandler('create_mr', handleCreateMr)
    registerCapabilityHandler('ai_review_mr', handleReviewMr)
    registerCapabilityHandler('notify_bug', handleNotify)
    registerAnalysisBugHandler()
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
      iid: 77,
      url: 'http://git.example.com/PAM/pas-api/-/issues/77',
    })
    ;(gitlabPostIssueNote as any).mockResolvedValue({
      issueUrl: 'http://git.example.com/PAM/pas-api/-/issues/77',
    })
  })

  it('审批 timeout → aborted → retry 复用 Issue + 新 Pipeline', async () => {
    // ── Step 1: 先跑一轮 analyze + pipeline，审批超时 ──
    vi.spyOn(PipelineApprovalManager.prototype, 'requestApproval').mockResolvedValueOnce('timeout')

    const analyzerResult = await handleAnalyzeBug({
      capabilityKey: 'analyze_bug',
      context: { taskId: 't', groupId: 'g', platform: 'test', initiatorId: 'u-trigger', initiatorRole: 'developer' },
      extraParams: { productLineId, message: 'L3 bug' },
    })
    expect(analyzerResult.success).toBe(true)
    const reportId = (analyzerResult.data as any).reportId

    await handleAnalysisComplete(reportId, 'l3', 'bug', 'u-trigger')

    const aborted = await getBugAnalysisReportById(reportId)
    expect(aborted!.status).toBe('aborted')

    // approval 事件写入
    const approvalEvents = await findByReportCode(reportId, 'approval')
    expect(approvalEvents).toHaveLength(1)
    expect((approvalEvents[0].data as any).decision).toBe('timeout')

    // 补发 notify_bug：approval_timeout 场景不再发 DM（触发人通道已取消，owner 也不收），
    // 因此不会产生 notify 事件
    const notifyEvents = await findByReportCode(reportId, 'notify')
    expect(notifyEvents).toHaveLength(0)

    // ── Step 2: 调用 retry endpoint ──
    // 启用 retry mock：第二轮走"审批被批准"路径，让 pipeline 一路到 notify
    vi.spyOn(PipelineApprovalManager.prototype, 'requestApproval').mockResolvedValue('approved')
    // mock 后续 pipeline stages
    const fixLogic = await import('../../agent/fix/fix-logic.js')
    ;(fixLogic.runFixForProject as any).mockResolvedValue({
      branch: 'fix/issue-77-1',
      testPassed: true,
      output: '所有测试通过',
    })
    const mr = await import('../../agent/mr/gitlab-mr.js')
    ;(mr.gitlabCreateMr as any).mockResolvedValue({
      iid: 200,
      url: 'http://git.example.com/PAM/pas-api/-/merge_requests/200',
    })
    const rev = await import('../../agent/review/claude-review.js')
    ;(rev.runClaudeReview as any).mockResolvedValue({ label: 'ai-approved', summary: 'LGTM' })

    const app = Fastify()
    await app.register(async (scope) => {
      await registerBugAnalysisReportRoutes(scope)
    })
    const res = await app.inject({ method: 'POST', url: `/bug-reports/${reportId}/retry` })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.success).toBe(true)
    expect(body.data.issueId).toBe(77) // 复用原 Issue
    const newReportId = body.data.newReportId
    expect(newReportId).not.toBe(reportId)

    const newReport = await getBugAnalysisReportById(newReportId)
    expect(newReport!.issueId).toBe(77) // 复用
    expect(newReport!.status).toBe('pipeline_success')

    // 新 report 的 create_issue 事件应标记 isReused=true
    const newCreateIssueEvents = await findByReportCode(newReportId, 'create_issue')
    expect(newCreateIssueEvents).toHaveLength(1)
    expect((newCreateIssueEvents[0].data as any).isReused).toBe(true)

    // gitlabPostIssueNote 被调（复用 Issue 走 note 路径）
    expect(gitlabPostIssueNote).toHaveBeenCalled()

    await app.close()
  }, 30_000)
})
