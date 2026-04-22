/**
 * AC2: L3 多 project 审批 + 主/从仓库（graph-runner approval stage 版本）
 *
 * 流程:
 *   analyze_bug → handleAnalysisComplete → coordinator 发 FYI DM 给从仓库 owner
 *   → runPipeline → graph-runner approval stage
 *   → 调用 approval resolver 'primary_project_owner' 查出主仓库 owner
 *   → PipelineApprovalManager.requestCard 发审批卡片（spy 掉不真发）
 *   → 模拟 approved：直接调 resumeRun 恢复 graph
 *   → 继续 fix_bug_l3 → create_mr → ai_review → notify
 *   → report.status=pipeline_success
 *
 * 相比老版（approve_l3 capability + requestApproval）的关键差异:
 *   - 审批人不再在 capability handler 里查，由 approval resolver 返回
 *   - 挂起/恢复走 LangGraph interrupt + Command.resume，不再是 Promise
 *   - graph-runner fire-and-forget，spec 必须 poll 等 pipeline 到达 approval 态
 */
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest'
import { Command } from '@langchain/langgraph'

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

import { resetTestDb } from '../helpers/db.js'
import { baseSeed, seedProject } from '../helpers/bug-fix-seed.js'
import { handleAnalyzeBug } from '../../agent/analysis/analyzer.js'
import { handleAnalysisComplete, registerCapabilityHandler } from '../../agent/coordinator.js'
import { handleCreateMr } from '../../agent/mr/mr-handler.js'
import { handleFixBug } from '../../agent/fix/fix-runner.js'
import { handleReviewMr } from '../../agent/review/reviewer.js'
import { handleNotify } from '../../agent/notify/notify-handler.js'
import { getBugAnalysisReportById } from '../../db/repositories/bug-analysis-reports.js'
import { findByReport } from '../../db/repositories/bug-fix-events.js'
import { PipelineApprovalManager } from '../../pipeline/approval-manager.js'
import { resumeRun, initGraphRunnerDispatchers } from '../../pipeline/graph-runner.js'
import { resetCheckpointerForTesting } from '../../pipeline/graph-runtime.js'
import { registerBuiltinApprovalResolvers } from '../../agent/approval/resolvers.js'
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
    registerCapabilityHandler('create_mr', handleCreateMr)
    registerCapabilityHandler('ai_review_mr', handleReviewMr)
    registerCapabilityHandler('notify_bug', handleNotify)
    registerBuiltinApprovalResolvers() // primary_project_owner resolver
  })

  beforeEach(async () => {
    await resetTestDb()
    // resetTestDb 删了 public schema 里所有表（包括 LangGraph 自己建的 checkpoints）；
    // 必须重置 PostgresSaver 的 singleton cache，否则 case 2+ 会用老 saver 实例连
    // 不存在的 checkpoints 表，报 "relation public.checkpoints does not exist"
    resetCheckpointerForTesting()
    vi.clearAllMocks()

    const seed = await baseSeed()
    productLineId = seed.productLineId
    await seedProject(productLineId, {
      name: 'pas-api', gitlabPath: 'PAM/pas-api',
      ownerId: 'u-primary', ownerName: '主负责人',
    })
    await seedProject(productLineId, {
      name: 'pas-web', gitlabPath: 'PAM/pas-web',
      ownerId: 'u-secondary', ownerName: '从负责人',
    })

    mockAdapter = makeMockAdapter()
    PipelineApprovalManager.initialize([mockAdapter])
    // approval-manager.initialize 之后才能 getInstance + setResumeHandler
    initGraphRunnerDispatchers()

    ;(runFilterStage as any).mockResolvedValue({
      involvedProjects: [
        { projectPath: 'PAM/pas-api', isPrimary: true, sourceBranch: 'test' },
        { projectPath: 'PAM/pas-web', isPrimary: false, sourceBranch: 'test' },
      ],
      primaryProjectPath: 'PAM/pas-api',
    })
    ;(runDetailStage as any).mockResolvedValue({ kind: 'detail', detail: {
      classification: 'bug', level: 'l3',
      confidence: 'medium', confidenceScore: 0.7,
      rootCause: { type: 'logic', summary: '多服务串联校验错', file: 'x.java', lineRange: [1, 10] },
      solutions: [{ id: 'a', summary: '业务改逻辑', recommended: true, risk: 'medium', effort: 'medium' }],
      affectedModules: ['auth'],
      analysisSteps: ['读代码'],
      markdown: '# L3 分析',
    }})
    ;(gitlabCreateIssue as any).mockResolvedValue({
      iid: 99,
      url: 'http://git.example.com/PAM/pas-api/-/issues/99',
    })
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
  })

  afterEach(async () => {
    // 等上个 case 的 fire-and-forget pipeline 背景 async flush（notify_bug / coordinator.onComplete 等）
    // 否则下个 case 的 resetTestDb 可能打断未完成的 stage，导致 runRegistry 残留
    await new Promise(r => setTimeout(r, 300))
    vi.restoreAllMocks()
  })

  it('approval approved → 全链路跑通 + 主 owner 收卡片 + 从仓库 owner 收 FYI', async () => {
    // ── 1. 触发 analyze_bug ──
    const analyzerResult = await handleAnalyzeBug({
      capabilityKey: 'analyze_bug',
      context: { taskId: 't2', groupId: 'g1', platform: 'test', initiatorId: 'u-trigger', initiatorRole: 'developer' },
      extraParams: { productLineId, message: 'L3 多 project Bug' },
    })
    expect(analyzerResult.success).toBe(true)
    const reportId = (analyzerResult.data as any).reportId

    // ── 2. spy requestCard（graph-runner 到 approval stage 时调它发钉钉卡片，
    //      我们不真发，只捕获参数）──
    const requestCardSpy = vi
      .spyOn(PipelineApprovalManager.prototype, 'requestCard')
      .mockResolvedValue('mock-approval-id')

    // ── 3. 触发 pipeline（runPipeline 内部 fire-and-forget 返回 runId） ──
    await handleAnalysisComplete(reportId, 'l3', 'bug', 'u-trigger')

    // ── 4. poll 等 approval stage 触发（requestCard 被调就说明 graph 已进入 approval 节点） ──
    const pollStart = Date.now()
    while (requestCardSpy.mock.calls.length === 0 && Date.now() - pollStart < 5000) {
      await new Promise(r => setTimeout(r, 50))
    }
    expect(requestCardSpy).toHaveBeenCalled()
    const cardArg = requestCardSpy.mock.calls[0][0] as {
      runId: number
      stageIndex: number
      approverIds: string[]
      description: string
    }
    expect(cardArg.approverIds).toEqual(['u-primary']) // resolver 查到主仓库 owner
    // description 是 approval stage 渲染的 markdown（含 Issue / 产线 / 等级 字段），
    // 只断言语义稳定的字段名，避免因文案微调反复失败
    expect(cardArg.description).toContain('Issue')
    expect(cardArg.description).toContain('L3')

    // ── 5. 模拟主 owner 点"同意"：调 resumeRun 恢复 graph ──
    await resumeRun(cardArg.runId, new Command({ resume: 'approved' }))

    // ── 6. poll 等 pipeline 跑完 ──
    let report = await getBugAnalysisReportById(reportId)
    const finalStart = Date.now()
    while (
      report?.status !== 'pipeline_success' &&
      report?.status !== 'aborted' &&
      Date.now() - finalStart < 10000
    ) {
      await new Promise(r => setTimeout(r, 100))
      report = await getBugAnalysisReportById(reportId)
    }
    expect(report!.status).toBe('pipeline_success')
    expect(report!.primaryProjectPath).toBe('PAM/pas-api')

    // ── 7. 从仓库 owner 收 FYI DM（coordinator 在 runPipeline 前发的） ──
    const fyiCall = mockAdapter.sendDirectMessage.mock.calls.find(c => c[0] === 'u-secondary')
    expect(fyiCall).toBeTruthy()
    const fyiText = (fyiCall![1] as { text: string }).text
    expect(fyiText).toContain('知情')

    // ── 8. 两个 project 分别 fix + MR ──
    expect(runFixForProject).toHaveBeenCalledTimes(2)
    expect(gitlabCreateMr).toHaveBeenCalledTimes(2)

    const mrCalls = (gitlabCreateMr as any).mock.calls as any[][]
    const primaryCall = mrCalls.find(c => c[0].projectPath === 'PAM/pas-api')
    const secondaryCall = mrCalls.find(c => c[0].projectPath === 'PAM/pas-web')
    expect(primaryCall).toBeDefined()
    expect(secondaryCall).toBeDefined()
    expect(primaryCall![0].description).toContain('Closes #99')
    expect(secondaryCall![0].description).toContain('Related to PAM/pas-api#99')

    // ── 9. notify_bug 发给两个 owner（触发人不发）──
    const events = await findByReport(reportId)
    const notifyEvents = events.filter(e => e.code === 'notify')
    expect(notifyEvents.length).toBe(2)
    const notifyUsers = new Set(notifyEvents.map(e => (e.data as any).userId))
    expect(notifyUsers.has('u-primary')).toBe(true)
    expect(notifyUsers.has('u-secondary')).toBe(true)
    expect(notifyUsers.has('u-trigger')).toBe(false)
  }, 30_000)

  it('approval rejected → pipeline aborted，不跑 fix', async () => {
    const analyzerResult = await handleAnalyzeBug({
      capabilityKey: 'analyze_bug',
      context: { taskId: 't3', groupId: 'g1', platform: 'test', initiatorId: 'u-trigger', initiatorRole: 'developer' },
      extraParams: { productLineId, message: 'L3 Bug 要被拒绝' },
    })
    const reportId = (analyzerResult.data as any).reportId

    const requestCardSpy = vi
      .spyOn(PipelineApprovalManager.prototype, 'requestCard')
      .mockResolvedValue('mock-approval-id')

    await handleAnalysisComplete(reportId, 'l3', 'bug', 'u-trigger')

    const pollStart = Date.now()
    while (requestCardSpy.mock.calls.length === 0 && Date.now() - pollStart < 5000) {
      await new Promise(r => setTimeout(r, 50))
    }
    const cardArg = requestCardSpy.mock.calls[0][0] as { runId: number }

    // 模拟主 owner 点"拒绝"
    await resumeRun(cardArg.runId, new Command({ resume: 'rejected' }))

    // poll 等到 aborted
    let report = await getBugAnalysisReportById(reportId)
    const finalStart = Date.now()
    while (
      report?.status !== 'pipeline_success' &&
      report?.status !== 'aborted' &&
      Date.now() - finalStart < 5000
    ) {
      await new Promise(r => setTimeout(r, 100))
      report = await getBugAnalysisReportById(reportId)
    }
    expect(report!.status).toBe('aborted')

    // fix/MR/review 不应被调
    expect(runFixForProject).not.toHaveBeenCalled()
    expect(gitlabCreateMr).not.toHaveBeenCalled()
  }, 30_000)
})
