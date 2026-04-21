import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resetTestDb, getTestPool } from '../helpers/db.js'
import { handleReviewMr } from '../../agent/review/reviewer.js'
import {
  createEvent,
  findByReportCode,
} from '../../db/repositories/bug-fix-events.js'
import { createBugAnalysisReport } from '../../db/repositories/bug-analysis-reports.js'

vi.mock('../../agent/review/claude-review.js', () => ({
  runClaudeReview: vi.fn(),
}))
vi.mock('../../agent/review/gitlab-mr-note.js', () => ({
  gitlabPostMrNote: vi.fn(),
  gitlabUpdateMrLabels: vi.fn(),
}))

import { runClaudeReview } from '../../agent/review/claude-review.js'
import {
  gitlabPostMrNote,
  gitlabUpdateMrLabels,
} from '../../agent/review/gitlab-mr-note.js'

interface MrSeed {
  projectPath: string
  mrIid: number
  mrUrl?: string
  isPrimary?: boolean
}

async function seedProductLine(): Promise<number> {
  const pool = getTestPool()
  const { rows } = await pool.query(
    `INSERT INTO product_lines (name, display_name, description)
     VALUES ('pam', 'PAM', 'test')
     ON CONFLICT (name) DO UPDATE SET display_name = EXCLUDED.display_name
     RETURNING id`,
  )
  return rows[0].id as number
}

async function seedReportWithMrs(opts: {
  mrs: MrSeed[]
  issueIid?: number
}): Promise<number> {
  const productLineId = await seedProductLine()
  const primary = opts.mrs.find(m => m.isPrimary) ?? opts.mrs[0]
  const issueIid = opts.issueIid ?? 1000

  const report = await createBugAnalysisReport({
    issueId: issueIid,
    issueUrl: `http://git.example.com/${primary.projectPath}/-/issues/${issueIid}`,
    productLineId,
    agentSessionId: null,
    level: 'l2',
    classification: 'bug',
    confidence: 'medium',
    confidenceScore: 0.8,
    rootCauseSummary: '测试根因',
    solutionsJson: [{ id: 'a', summary: 's', recommended: true, risk: 'low', effort: 'small' }],
    affectedModules: ['auth'],
    analysisSteps: null,
    metadata: null,
    primaryProjectPath: primary.projectPath,
  })

  for (const m of opts.mrs) {
    await createEvent({
      reportId: report.id,
      projectPath: m.projectPath,
      code: 'create_mr',
      status: 'success',
      data: {
        mrIid: m.mrIid,
        mrUrl: m.mrUrl ?? `http://git.example.com/${m.projectPath}/-/merge_requests/${m.mrIid}`,
        branch: `fix/issue-${issueIid}-a1`,
        isPrimary: m.isPrimary ?? (m === primary),
      },
    })
  }

  return report.id
}

describe('ai_review_mr handler（改造版：多 MR + Note + 幂等）', () => {
  beforeEach(async () => {
    await resetTestDb()
    vi.mocked(runClaudeReview).mockReset()
    vi.mocked(gitlabPostMrNote).mockReset()
    vi.mocked(gitlabUpdateMrLabels).mockReset()
  })

  it('单 MR: 写 Note + 写 label + 写 ai_review 事件', async () => {
    const reportId = await seedReportWithMrs({
      mrs: [{ projectPath: 'PAM/pas-api', mrIid: 55, isPrimary: true }],
    })
    vi.mocked(runClaudeReview).mockResolvedValue({ label: 'ai-approved', summary: '代码合理' })
    vi.mocked(gitlabPostMrNote).mockResolvedValue(undefined)
    vi.mocked(gitlabUpdateMrLabels).mockResolvedValue(undefined)

    const result = await handleReviewMr({
      capabilityKey: 'ai_review_mr',
      context: { taskId: 't', groupId: 'g', platform: 'pipeline', initiatorId: 'p', initiatorRole: 'admin' },
      extraParams: { reportId },
    })

    expect(result.success).toBe(true)
    expect(result.output).toContain('完成 Review 1 个 MR')

    expect(gitlabPostMrNote).toHaveBeenCalledTimes(1)
    expect(gitlabPostMrNote).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: 'PAM/pas-api',
        mrIid: 55,
        body: expect.stringContaining('代码合理'),
      }),
    )
    // 单 MR 不应包含跨服务警告
    const noteBody = vi.mocked(gitlabPostMrNote).mock.calls[0][0].body
    expect(noteBody).not.toContain('此为跨服务修复')
    expect(noteBody).toContain('ai-approved')

    expect(gitlabUpdateMrLabels).toHaveBeenCalledWith(
      expect.objectContaining({ projectPath: 'PAM/pas-api', mrIid: 55, labelToAdd: 'ai-approved' }),
    )

    const events = await findByReportCode(reportId, 'ai_review')
    expect(events).toHaveLength(1)
    expect(events[0].status).toBe('success')
    expect(events[0].projectPath).toBe('PAM/pas-api')
    const data = events[0].data as Record<string, unknown>
    expect(data.label).toBe('ai-approved')
    expect(data.mrIid).toBe(55)
    expect(data.reviewSummary).toBe('代码合理')
  })

  it('多 MR: 每个 MR 写 Note + 写 label + 写 ai_review 事件', async () => {
    const reportId = await seedReportWithMrs({
      mrs: [
        { projectPath: 'PAM/pas-6.0', mrIid: 55, isPrimary: true },
        { projectPath: 'PAM/pas-api', mrIid: 77 },
      ],
    })
    vi.mocked(runClaudeReview).mockResolvedValue({ label: 'ai-approved', summary: '代码合理' })
    vi.mocked(gitlabPostMrNote).mockResolvedValue(undefined)
    vi.mocked(gitlabUpdateMrLabels).mockResolvedValue(undefined)

    const result = await handleReviewMr({
      capabilityKey: 'ai_review_mr',
      context: { taskId: 't', groupId: 'g', platform: 'pipeline', initiatorId: 'p', initiatorRole: 'admin' },
      extraParams: { reportId },
    })

    expect(result.success).toBe(true)
    expect(gitlabPostMrNote).toHaveBeenCalledTimes(2)
    expect(runClaudeReview).toHaveBeenCalledTimes(2)

    const events = await findByReportCode(reportId, 'ai_review')
    expect(events).toHaveLength(2)
    const paths = events.map(e => e.projectPath).sort()
    expect(paths).toEqual(['PAM/pas-6.0', 'PAM/pas-api'])
  })

  it('多 project 场景: Review note 开头含跨服务警告', async () => {
    const reportId = await seedReportWithMrs({
      mrs: [
        { projectPath: 'PAM/pas-6.0', mrIid: 55, isPrimary: true },
        { projectPath: 'PAM/pas-api', mrIid: 77 },
      ],
    })
    vi.mocked(runClaudeReview).mockResolvedValue({ label: 'ai-approved', summary: 'OK' })
    vi.mocked(gitlabPostMrNote).mockResolvedValue(undefined)
    vi.mocked(gitlabUpdateMrLabels).mockResolvedValue(undefined)

    await handleReviewMr({
      capabilityKey: 'ai_review_mr',
      context: { taskId: 't', groupId: 'g', platform: 'pipeline', initiatorId: 'p', initiatorRole: 'admin' },
      extraParams: { reportId },
    })

    const calls = vi.mocked(gitlabPostMrNote).mock.calls
    expect(calls).toHaveLength(2)
    for (const [input] of calls) {
      expect(input.body).toContain('此为跨服务修复的一部分')
      expect(input.body).toContain('2 个 MR')
    }
  })

  it('幂等: 跳过已有 ai_review 成功事件的 MR', async () => {
    const reportId = await seedReportWithMrs({
      mrs: [
        { projectPath: 'PAM/pas-6.0', mrIid: 55, isPrimary: true },
        { projectPath: 'PAM/pas-api', mrIid: 77 },
      ],
    })
    await createEvent({
      reportId,
      projectPath: 'PAM/pas-6.0',
      code: 'ai_review',
      status: 'success',
      data: { mrIid: 55, label: 'ai-approved', reviewSummary: 'old' },
    })

    vi.mocked(runClaudeReview).mockResolvedValue({ label: 'ai-approved', summary: 'new' })
    vi.mocked(gitlabPostMrNote).mockResolvedValue(undefined)
    vi.mocked(gitlabUpdateMrLabels).mockResolvedValue(undefined)

    const result = await handleReviewMr({
      capabilityKey: 'ai_review_mr',
      context: { taskId: 't', groupId: 'g', platform: 'pipeline', initiatorId: 'p', initiatorRole: 'admin' },
      extraParams: { reportId },
    })

    expect(result.success).toBe(true)
    // 只跑未 review 的 MR
    expect(runClaudeReview).toHaveBeenCalledTimes(1)
    const reviewCall = vi.mocked(runClaudeReview).mock.calls[0][0]
    expect(reviewCall.projectPath).toBe('PAM/pas-api')
    expect(reviewCall.mrIid).toBe(77)

    expect(gitlabPostMrNote).toHaveBeenCalledTimes(1)
    // 幂等跳过时不新增事件
    const events = await findByReportCode(reportId, 'ai_review')
    expect(events).toHaveLength(2) // 一个旧的 + 一个新的
  })

  it('无 create_mr 事件: 返回 no_mrs', async () => {
    const productLineId = await seedProductLine()
    const report = await createBugAnalysisReport({
      issueId: 9999,
      issueUrl: 'http://x',
      productLineId,
      agentSessionId: null,
      level: 'l2',
      classification: 'bug',
      confidence: 'medium',
      confidenceScore: 0.8,
      rootCauseSummary: 'x',
      solutionsJson: [],
      affectedModules: ['a'],
      analysisSteps: null,
      metadata: null,
      primaryProjectPath: 'PAM/x',
    })

    const result = await handleReviewMr({
      capabilityKey: 'ai_review_mr',
      context: { taskId: 't', groupId: 'g', platform: 'pipeline', initiatorId: 'p', initiatorRole: 'admin' },
      extraParams: { reportId: report.id },
    })

    expect(result.success).toBe(false)
    expect(result.error).toBe('no_mrs')
    expect(runClaudeReview).not.toHaveBeenCalled()
    expect(gitlabPostMrNote).not.toHaveBeenCalled()
  })

  it('只有 failed create_mr 事件: 视为无 MR 可 Review', async () => {
    const productLineId = await seedProductLine()
    const report = await createBugAnalysisReport({
      issueId: 8888,
      issueUrl: 'http://x',
      productLineId,
      agentSessionId: null,
      level: 'l2',
      classification: 'bug',
      confidence: 'medium',
      confidenceScore: 0.8,
      rootCauseSummary: 'x',
      solutionsJson: [],
      affectedModules: ['a'],
      analysisSteps: null,
      metadata: null,
      primaryProjectPath: 'PAM/x',
    })
    await createEvent({
      reportId: report.id,
      projectPath: 'PAM/x',
      code: 'create_mr',
      status: 'failed',
      data: { error: 'boom' },
    })

    const result = await handleReviewMr({
      capabilityKey: 'ai_review_mr',
      context: { taskId: 't', groupId: 'g', platform: 'pipeline', initiatorId: 'p', initiatorRole: 'admin' },
      extraParams: { reportId: report.id },
    })

    expect(result.success).toBe(false)
    expect(result.error).toBe('no_mrs')
  })

  it('部分失败: 记录 failed 事件, 返回 review_failed', async () => {
    const reportId = await seedReportWithMrs({
      mrs: [
        { projectPath: 'PAM/a', mrIid: 1, isPrimary: true },
        { projectPath: 'PAM/b', mrIid: 2 },
      ],
    })
    vi.mocked(runClaudeReview)
      .mockResolvedValueOnce({ label: 'ai-approved', summary: 'ok' })
      .mockRejectedValueOnce(new Error('Claude 挂了'))
    vi.mocked(gitlabPostMrNote).mockResolvedValue(undefined)
    vi.mocked(gitlabUpdateMrLabels).mockResolvedValue(undefined)

    const result = await handleReviewMr({
      capabilityKey: 'ai_review_mr',
      context: { taskId: 't', groupId: 'g', platform: 'pipeline', initiatorId: 'p', initiatorRole: 'admin' },
      extraParams: { reportId },
    })

    expect(result.success).toBe(false)
    expect(result.error).toBe('review_failed')

    const events = await findByReportCode(reportId, 'ai_review')
    expect(events).toHaveLength(2)
    const statuses = events.map(e => e.status).sort()
    expect(statuses).toEqual(['failed', 'success'])
    const failed = events.find(e => e.status === 'failed')!
    expect((failed.data as Record<string, unknown>).error).toContain('Claude 挂了')
  })

  it('Note 写失败: 记录 failed 事件并返回 review_failed', async () => {
    const reportId = await seedReportWithMrs({
      mrs: [{ projectPath: 'PAM/pas-api', mrIid: 55, isPrimary: true }],
    })
    vi.mocked(runClaudeReview).mockResolvedValue({ label: 'ai-approved', summary: 'ok' })
    vi.mocked(gitlabPostMrNote).mockRejectedValue(new Error('GitLab 500'))

    const result = await handleReviewMr({
      capabilityKey: 'ai_review_mr',
      context: { taskId: 't', groupId: 'g', platform: 'pipeline', initiatorId: 'p', initiatorRole: 'admin' },
      extraParams: { reportId },
    })

    expect(result.success).toBe(false)
    expect(result.error).toBe('review_failed')
    const events = await findByReportCode(reportId, 'ai_review')
    expect(events).toHaveLength(1)
    expect(events[0].status).toBe('failed')
  })

  it('缺少 reportId: 返回 missing_reportId', async () => {
    const result = await handleReviewMr({
      capabilityKey: 'ai_review_mr',
      context: { taskId: 't', groupId: 'g', platform: 'pipeline', initiatorId: 'p', initiatorRole: 'admin' },
      extraParams: {},
    })
    expect(result.success).toBe(false)
    expect(result.error).toBe('missing_reportId')
  })

  it('ai-needs-attention label 正常传递', async () => {
    const reportId = await seedReportWithMrs({
      mrs: [{ projectPath: 'PAM/pas-api', mrIid: 55, isPrimary: true }],
    })
    vi.mocked(runClaudeReview).mockResolvedValue({ label: 'ai-needs-attention', summary: '有风险点' })
    vi.mocked(gitlabPostMrNote).mockResolvedValue(undefined)
    vi.mocked(gitlabUpdateMrLabels).mockResolvedValue(undefined)

    await handleReviewMr({
      capabilityKey: 'ai_review_mr',
      context: { taskId: 't', groupId: 'g', platform: 'pipeline', initiatorId: 'p', initiatorRole: 'admin' },
      extraParams: { reportId },
    })

    expect(gitlabUpdateMrLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labelToAdd: 'ai-needs-attention' }),
    )
    const noteBody = vi.mocked(gitlabPostMrNote).mock.calls[0][0].body
    expect(noteBody).toContain('ai-needs-attention')
    expect(noteBody).toContain('有风险点')
  })
})
