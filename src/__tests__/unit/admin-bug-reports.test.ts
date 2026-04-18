import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

// ── Mock deps BEFORE importing the route module ─────────────────────────────

vi.mock('../../db/repositories/bug-analysis-reports.js', () => ({
  getBugAnalysisReportById: vi.fn(),
  listReportsByProductLine: vi.fn(async () => []),
}))

vi.mock('../../db/repositories/bug-fix-events.js', () => ({
  findByReport: vi.fn(async () => []),
}))

vi.mock('../../agent/analysis/analyzer.js', () => ({
  handleAnalyzeBug: vi.fn(),
}))

vi.mock('../../agent/coordinator.js', () => ({
  handleAnalysisComplete: vi.fn(async () => {}),
}))

import { registerBugAnalysisReportRoutes } from '../../admin/routes/bug-analysis-reports.js'
import { getBugAnalysisReportById } from '../../db/repositories/bug-analysis-reports.js'
import { findByReport } from '../../db/repositories/bug-fix-events.js'
import { handleAnalyzeBug } from '../../agent/analysis/analyzer.js'
import { handleAnalysisComplete } from '../../agent/coordinator.js'

async function buildApp() {
  const app = Fastify()
  await app.register(async (scope) => {
    await registerBugAnalysisReportRoutes(scope)
  })
  return app
}

const abortedReport = {
  id: 42,
  issueId: 501,
  issueUrl: 'https://gitlab/test/issues/501',
  productLineId: 7,
  agentSessionId: null,
  level: 'l2' as const,
  classification: 'bug' as const,
  confidence: 'high' as const,
  confidenceScore: 0.9,
  rootCauseSummary: '',
  solutionsJson: [],
  affectedModules: [],
  analysisSteps: [],
  metadata: null,
  status: 'aborted' as const,
  pipelineRunId: null,
  primaryProjectPath: null,
  createdAt: new Date(),
  updatedAt: new Date(),
}

describe('POST /bug-reports/:id/retry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 404 when report not found', async () => {
    ;(getBugAnalysisReportById as any).mockResolvedValue(null)
    const app = await buildApp()
    const res = await app.inject({ method: 'POST', url: '/bug-reports/999/retry' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ success: false, error: 'REPORT_NOT_FOUND' })
    await app.close()
  })

  it('returns 409 when status is not aborted', async () => {
    ;(getBugAnalysisReportById as any).mockResolvedValue({
      ...abortedReport,
      status: 'published',
    })
    const app = await buildApp()
    const res = await app.inject({ method: 'POST', url: '/bug-reports/42/retry' })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ success: false, error: 'REPORT_NOT_RETRYABLE' })
    await app.close()
  })

  it('returns 409 when report has no issue id', async () => {
    ;(getBugAnalysisReportById as any).mockResolvedValue({
      ...abortedReport,
      issueId: 0,
    })
    const app = await buildApp()
    const res = await app.inject({ method: 'POST', url: '/bug-reports/42/retry' })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ success: false, error: 'NO_ISSUE' })
    await app.close()
  })

  it('returns 400 when id is non-numeric', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'POST', url: '/bug-reports/abc/retry' })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ success: false, error: 'INVALID_ID' })
    await app.close()
  })

  it('returns 502 when analyzer fails', async () => {
    ;(getBugAnalysisReportById as any).mockResolvedValue(abortedReport)
    ;(handleAnalyzeBug as any).mockResolvedValue({
      success: false,
      error: 'claude_timeout',
      output: '分析失败: timeout',
    })
    const app = await buildApp()
    const res = await app.inject({ method: 'POST', url: '/bug-reports/42/retry' })
    expect(res.statusCode).toBe(502)
    expect(res.json()).toMatchObject({ success: false, error: 'GITLAB_API_ERROR' })
    await app.close()
  })

  it('returns 500 when analyzer throws', async () => {
    ;(getBugAnalysisReportById as any).mockResolvedValue(abortedReport)
    ;(handleAnalyzeBug as any).mockRejectedValue(new Error('unexpected boom'))
    const app = await buildApp()
    const res = await app.inject({ method: 'POST', url: '/bug-reports/42/retry' })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toMatchObject({ success: false, error: 'INTERNAL_ERROR' })
    await app.close()
  })

  it('on successful retry with bug classification: triggers Pipeline and returns newRunId', async () => {
    // First call: read original aborted report
    // Subsequent call: read the newly-created report (reloaded) to pick up pipelineRunId
    ;(getBugAnalysisReportById as any)
      .mockResolvedValueOnce(abortedReport)
      .mockResolvedValueOnce({ ...abortedReport, id: 77, pipelineRunId: 888 })

    ;(handleAnalyzeBug as any).mockResolvedValue({
      success: true,
      output: 'ok',
      data: { reportId: 77, classification: 'bug', level: 'l2' },
    })
    ;(handleAnalysisComplete as any).mockResolvedValue(undefined)

    const app = await buildApp()
    const res = await app.inject({ method: 'POST', url: '/bug-reports/42/retry' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toMatchObject({
      success: true,
      data: {
        newReportId: 77,
        newRunId: 888,
        issueId: 501,
        issueUrl: 'https://gitlab/test/issues/501',
      },
    })
    // handleAnalyzeBug called with reuseIssueId
    expect(handleAnalyzeBug).toHaveBeenCalledWith(expect.objectContaining({
      capabilityKey: 'analyze_bug',
      extraParams: expect.objectContaining({
        reuseIssueId: 501,
        productLineId: 7,
      }),
    }))
    expect(handleAnalysisComplete).toHaveBeenCalledWith(77, 'l2', 'bug', 'admin')
    await app.close()
  })

  it('on successful retry with non-bug classification: does NOT trigger Pipeline, newRunId undefined', async () => {
    ;(getBugAnalysisReportById as any).mockResolvedValueOnce(abortedReport)
    ;(handleAnalyzeBug as any).mockResolvedValue({
      success: true,
      output: 'ok',
      data: { reportId: 88, classification: 'usage_issue', level: 'l1' },
    })

    const app = await buildApp()
    const res = await app.inject({ method: 'POST', url: '/bug-reports/42/retry' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.success).toBe(true)
    expect(body.data.newReportId).toBe(88)
    expect(body.data.newRunId).toBeUndefined()
    expect(handleAnalysisComplete).not.toHaveBeenCalled()
    await app.close()
  })
})

describe('GET /bug-reports/:id/events', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 400 when id is non-numeric', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/bug-reports/abc/events' })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: { code: 'INVALID_ID' } })
    await app.close()
  })

  it('returns empty array when report has no events', async () => {
    ;(findByReport as any).mockResolvedValue([])
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/bug-reports/42/events' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ data: [] })
    expect(findByReport).toHaveBeenCalledWith(42)
    await app.close()
  })

  it('returns all events for the report', async () => {
    const now = new Date()
    const events = [
      {
        id: 1,
        reportId: 42,
        projectPath: null,
        code: 'analysis',
        status: 'success',
        durationMs: 5000,
        data: { level: 'l2', classification: 'bug' },
        createdAt: now,
      },
      {
        id: 2,
        reportId: 42,
        projectPath: 'PAM/x',
        code: 'scope_identified',
        status: 'success',
        durationMs: null,
        data: { isPrimary: true },
        createdAt: now,
      },
    ]
    ;(findByReport as any).mockResolvedValue(events)
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/bug-reports/42/events' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.data).toHaveLength(2)
    expect(body.data[0].code).toBe('analysis')
    expect(body.data[1].code).toBe('scope_identified')
    expect(body.data[1].projectPath).toBe('PAM/x')
    await app.close()
  })
})
