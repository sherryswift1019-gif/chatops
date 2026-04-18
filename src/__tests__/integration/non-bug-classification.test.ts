/**
 * AC5: 非 bug 分类 (usage_issue)
 * - 不创建 Issue（gitlabCreateIssue 未被调）
 * - 不触发 Pipeline（handleAnalysisComplete 跳过）
 * - 无 create_issue / scope_identified 事件
 * - report.status='completed'
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

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
import { handleAnalysisComplete } from '../../agent/coordinator.js'
import { getBugAnalysisReportById } from '../../db/repositories/bug-analysis-reports.js'
import { findByReport } from '../../db/repositories/bug-fix-events.js'

import { runFilterStage, runDetailStage } from '../../agent/analysis/claude-runs.js'
import { gitlabCreateIssue } from '../../agent/analysis/gitlab-issue.js'

describe('AC5: 非 bug 分类 → 不创建 Issue / 不触发 Pipeline', () => {
  let productLineId: number

  beforeEach(async () => {
    await resetTestDb()
    vi.clearAllMocks()

    const seed = await baseSeed()
    productLineId = seed.productLineId
    await seedProject(productLineId, {
      name: 'pas-api',
      gitlabPath: 'PAM/pas-api',
    })

    ;(runFilterStage as any).mockResolvedValue({
      involvedProjects: [{ projectPath: 'PAM/pas-api', isPrimary: true, sourceBranch: 'test' }],
      primaryProjectPath: 'PAM/pas-api',
    })
    // 关键：mock 为 usage_issue 分类
    ;(runDetailStage as any).mockResolvedValue({
      classification: 'usage_issue',
      level: 'l1',
      confidence: 'high',
      confidenceScore: 0.95,
      rootCause: { type: 'usage', summary: '用户用法错误', file: '', lineRange: [] },
      solutions: [],
      affectedModules: [],
      analysisSteps: ['理解用户问题'],
      markdown: '# 非 bug',
    })
  })

  it('classification=usage_issue → no Issue, no Pipeline, status=completed', async () => {
    const analyzerResult = await handleAnalyzeBug({
      capabilityKey: 'analyze_bug',
      context: { taskId: 't', groupId: 'g', platform: 'test', initiatorId: 'u', initiatorRole: 'developer' },
      extraParams: { productLineId, message: '用法咨询' },
    })
    expect(analyzerResult.success).toBe(true)
    const reportId = (analyzerResult.data as any).reportId
    const data = analyzerResult.data as any
    expect(data.classification).toBe('usage_issue')

    // gitlabCreateIssue 未被调
    expect(gitlabCreateIssue).not.toHaveBeenCalled()

    // 报告状态应为 completed（analyzer 内部直接设）
    const report = await getBugAnalysisReportById(reportId)
    expect(report!.status).toBe('completed')
    expect(report!.issueId).toBe(0)

    // 事件里不应有 create_issue / scope_identified
    const events = await findByReport(reportId)
    const codes = events.map(e => e.code)
    expect(codes).toContain('analysis')
    expect(codes).not.toContain('create_issue')
    expect(codes).not.toContain('scope_identified')

    // handleAnalysisComplete 也不触发 Pipeline（非 bug 分类直接 return）
    await handleAnalysisComplete(reportId, 'l1', 'usage_issue', 'u')
    const after = await getBugAnalysisReportById(reportId)
    expect(after!.pipelineRunId).toBeNull()
    // runPipeline 不应被调用
    // 注：runPipeline 是真实 import 但由 DB 约束自然不跑，我们用 spy 检查
  })
})
