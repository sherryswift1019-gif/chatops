/**
 * AC1: L2 单 project 端到端
 *   analyze → Pipeline (fix → create_mr → ai_review → notify) → status=pipeline_success
 *   webhook MR merge → status=completed
 */
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest'

// ── Mock 所有外部调用（必须在 import handler 之前） ───────────────────────────

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
      id: 'wt-test',
      path: '/tmp/chatops-wt-test',
      key: 'test-key',
      createdAt: new Date(),
    })),
    release: vi.fn(),
    makeWorktreeKey: vi.fn((opts: { productLineId: number; projectPath: string; branch: string }) =>
      `${opts.productLineId}-${opts.projectPath}-${opts.branch}`,
    ),
  }
})

// ── 真实 import（mock 已经生效） ────────────────────────────────────────────

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
import { handleMergeRequestEvent } from '../../adapters/gitlab/issue-handler.js'

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

describe('AC1: L2 单 project 端到端', () => {
  let productLineId: number
  let mockAdapter: IMAdapter & { sendDirectMessage: ReturnType<typeof vi.fn> }

  beforeAll(() => {
    // capability handler 必须在第一次 triggerCapability 前注册
    registerCapabilityHandler('fix_bug_l1', opts => handleFixBug(opts, 'l1'))
    registerCapabilityHandler('fix_bug_l2', opts => handleFixBug(opts, 'l2'))
    registerCapabilityHandler('fix_bug_l3', opts => handleFixBug(opts, 'l3'))
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

    mockAdapter = makeMockAdapter()
    PipelineApprovalManager.initialize([mockAdapter])

    // mock Claude 两阶段返回
    ;(runFilterStage as any).mockResolvedValue({
      involvedProjects: [{ projectPath: 'PAM/pas-api', isPrimary: true, sourceBranch: 'test' }],
      primaryProjectPath: 'PAM/pas-api',
    })
    ;(runDetailStage as any).mockResolvedValue({ kind: 'detail', detail: {
      classification: 'bug',
      level: 'l2',
      confidence: 'high',
      confidenceScore: 0.92,
      rootCause: { type: 'npe', summary: 'Null Pointer in token verify', file: 'a.java', lineRange: [10, 20] },
      solutions: [{ id: 'a', summary: '修空指针', recommended: true, risk: 'low', effort: 'small' }],
      affectedModules: ['auth'],
      analysisSteps: ['读代码'],
      markdown: '# 分析\n...\n',
    }})
    ;(gitlabCreateIssue as any).mockResolvedValue({
      iid: 42,
      url: 'http://git.example.com/PAM/pas-api/-/issues/42',
    })
    ;(runFixForProject as any).mockResolvedValue({
      branch: 'fix/issue-42-1',
      testPassed: true,
      output: '所有测试通过',
    })
    ;(gitlabCreateMr as any).mockResolvedValue({
      iid: 55,
      url: 'http://git.example.com/PAM/pas-api/-/merge_requests/55',
    })
    ;(runClaudeReview as any).mockResolvedValue({
      label: 'ai-approved',
      summary: 'LGTM',
    })
  })

  it('analyze → pipeline_success → MR merged → completed', async () => {
    // ── 1. 调 analyze_bug ──
    const analyzerResult = await handleAnalyzeBug({
      capabilityKey: 'analyze_bug',
      context: { taskId: 't1', groupId: 'g1', platform: 'test', initiatorId: 'u-trigger', initiatorRole: 'developer' },
      extraParams: { productLineId, message: '帮我看个 Bug' },
    })
    expect(analyzerResult.success).toBe(true)
    const reportId = (analyzerResult.data as any).reportId as number
    expect(reportId).toBeGreaterThan(0)

    // ── 2. 调 handleAnalysisComplete 触发 Pipeline ──
    await handleAnalysisComplete(reportId, 'l2', 'bug', 'u-trigger')

    // Pipeline 运行是异步的（runPipeline 内部有 await，但 onComplete 在 return 之后才 fire）
    // runPipeline 本身是 await 执行完整 pipeline 的，所以完成后立刻查状态
    const report = await getBugAnalysisReportById(reportId)
    expect(report).not.toBeNull()
    expect(report!.pipelineRunId).toBeTruthy()
    expect(report!.status).toBe('pipeline_success')

    // ── 3. 验证 events 齐全 ──
    const events = await findByReport(reportId)
    const codes = events.map(e => e.code)
    expect(codes).toContain('analysis')
    expect(codes).toContain('scope_identified')
    expect(codes).toContain('create_issue')
    expect(codes).toContain('fix_attempt')
    expect(codes).toContain('create_mr')
    expect(codes).toContain('ai_review')
    expect(codes).toContain('notify')

    // ── 4. webhook MR merged → completed ──
    await handleMergeRequestEvent({
      object_kind: 'merge_request',
      object_attributes: { iid: 55, title: 'fix', action: 'merge', source_branch: 'fix/issue-42-1', target_branch: 'test' },
      project: { path_with_namespace: 'PAM/pas-api' },
    })
    const final = await getBugAnalysisReportById(reportId)
    expect(final!.status).toBe('completed')

    // lifecycle_sync 事件
    const finalEvents = await findByReport(reportId)
    expect(finalEvents.some(e => e.code === 'lifecycle_sync')).toBe(true)
  }, 30_000)
})
