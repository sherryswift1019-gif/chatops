/**
 * AC2: L3 多 project 审批 + 主/从仓库
 *   2 个 project，主仓库 owner 收审批 DM + 从仓库 owner 收 FYI DM
 *   fix → create_mr 对 2 个 project 分别跑
 *   主仓库 MR description 含 `Closes #X`，从仓库含 `Related to`
 *   notify → 3 条 DM（2 owner + 1 trigger）
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
      id: 'wt',
      path: '/tmp/wt',
      key: 'k',
      createdAt: new Date(),
    })),
    release: vi.fn(),
    makeWorktreeKey: vi.fn(() => 'k'),
  }
})

import { resetTestDb } from '../helpers/db.js'
import { baseSeed, seedProject } from '../helpers/bug-fix-seed.js'
import { handleAnalyzeBug } from '../../agent/analysis/analyzer.js'
import { handleAnalysisComplete, registerCapabilityHandler } from '../../agent/coordinator.js'
import { handleCreateMr } from '../../agent/mr/mr-handler.js'
import { handleFixBug } from '../../agent/fix/fix-runner.js'
import { handleReviewMr } from '../../agent/review/reviewer.js'
import { handleNotify } from '../../agent/notify/notify-handler.js'
import { handleApproveL3 } from '../../agent/approval/approve-l3-handler.js'
import { getBugAnalysisReportById } from '../../db/repositories/bug-analysis-reports.js'
import { findByReport } from '../../db/repositories/bug-fix-events.js'
import { PipelineApprovalManager } from '../../pipeline/approval-manager.js'

import { runFilterStage, runDetailStage } from '../../agent/analysis/claude-runs.js'
import { gitlabCreateIssue } from '../../agent/analysis/gitlab-issue.js'
import { runFixForProject } from '../../agent/fix/fix-logic.js'
import { gitlabCreateMr } from '../../agent/mr/gitlab-mr.js'
import { runClaudeReview } from '../../agent/review/claude-review.js'
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

describe('AC2: L3 多 project 审批 + 主/从仓库', () => {
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
    await seedProject(productLineId, {
      name: 'pas-web',
      gitlabPath: 'PAM/pas-web',
      ownerId: 'u-secondary',
      ownerName: '从负责人',
    })

    mockAdapter = makeMockAdapter()
    PipelineApprovalManager.initialize([mockAdapter])

    ;(runFilterStage as any).mockResolvedValue({
      involvedProjects: [
        { projectPath: 'PAM/pas-api', isPrimary: true, sourceBranch: 'test' },
        { projectPath: 'PAM/pas-web', isPrimary: false, sourceBranch: 'test' },
      ],
      primaryProjectPath: 'PAM/pas-api',
    })
    ;(runDetailStage as any).mockResolvedValue({
      classification: 'bug',
      level: 'l3',
      confidence: 'medium',
      confidenceScore: 0.7,
      rootCause: { type: 'logic', summary: '多服务串联校验错', file: 'x.java', lineRange: [1, 10] },
      solutions: [{ id: 'a', summary: '业务改逻辑', recommended: true, risk: 'medium', effort: 'medium' }],
      affectedModules: ['auth'],
      analysisSteps: ['读代码'],
      markdown: '# L3 分析',
    })
    ;(gitlabCreateIssue as any).mockResolvedValue({
      iid: 99,
      url: 'http://git.example.com/PAM/pas-api/-/issues/99',
    })
    // 两个 project 分别 fix 成功
    ;(runFixForProject as any).mockImplementation(async (input: any) => ({
      branch: `fix/issue-99-${input.projectPath.split('/').pop()}`,
      testPassed: true,
      output: '所有测试通过',
    }))
    ;(gitlabCreateMr as any).mockImplementation(async (input: any) => ({
      iid: input.projectPath === 'PAM/pas-api' ? 100 : 200,
      url: `http://git.example.com/${input.projectPath}/-/merge_requests/${input.projectPath === 'PAM/pas-api' ? 100 : 200}`,
    }))
    ;(runClaudeReview as any).mockResolvedValue({ label: 'ai-approved', summary: 'LGTM' })

    // mock approval approved
    vi.spyOn(PipelineApprovalManager.prototype, 'requestApproval').mockResolvedValue('approved')
  })

  it('多 project 走完全链路，主/从 MR + 3 条 DM', async () => {
    const analyzerResult = await handleAnalyzeBug({
      capabilityKey: 'analyze_bug',
      context: { taskId: 't2', groupId: 'g1', platform: 'test', initiatorId: 'u-trigger', initiatorRole: 'developer' },
      extraParams: { productLineId, message: 'L3 多 project Bug' },
    })
    expect(analyzerResult.success).toBe(true)
    const reportId = (analyzerResult.data as any).reportId

    await handleAnalysisComplete(reportId, 'l3', 'bug', 'u-trigger')

    const report = await getBugAnalysisReportById(reportId)
    expect(report!.status).toBe('pipeline_success')
    expect(report!.primaryProjectPath).toBe('PAM/pas-api')

    // ── 审批 capability 调用情况 ──
    expect(PipelineApprovalManager.prototype.requestApproval).toHaveBeenCalled()
    const approvalCall = (PipelineApprovalManager.prototype.requestApproval as any).mock.calls[0]
    expect(approvalCall[0]).toEqual(['u-primary']) // approverIds

    // ── 从仓库 owner 收 FYI DM ──
    const fyiCall = mockAdapter.sendDirectMessage.mock.calls.find(c => c[0] === 'u-secondary')
    expect(fyiCall).toBeTruthy()
    const fyiText = (fyiCall![1] as { text: string }).text
    expect(fyiText).toContain('知情') // FYI 标识

    // ── 两个 project fix + MR ──
    expect(runFixForProject).toHaveBeenCalledTimes(2)
    expect(gitlabCreateMr).toHaveBeenCalledTimes(2)

    // 主/从 MR description
    const mrCalls = (gitlabCreateMr as any).mock.calls as any[][]
    const primaryCall = mrCalls.find(c => c[0].projectPath === 'PAM/pas-api')
    const secondaryCall = mrCalls.find(c => c[0].projectPath === 'PAM/pas-web')
    expect(primaryCall[0].description).toContain('Closes #99')
    expect(secondaryCall[0].description).toContain('Related to PAM/pas-api#99')

    // ── notify_bug 发 3 条 DM（去掉 FYI 调用） ──
    const events = await findByReport(reportId)
    const notifyEvents = events.filter(e => e.code === 'notify')
    expect(notifyEvents.length).toBe(3) // 2 owner + 1 trigger

    const notifyUsers = new Set(notifyEvents.map(e => (e.data as any).userId))
    expect(notifyUsers.has('u-primary')).toBe(true)
    expect(notifyUsers.has('u-secondary')).toBe(true)
    expect(notifyUsers.has('u-trigger')).toBe(true)
  }, 30_000)
})
