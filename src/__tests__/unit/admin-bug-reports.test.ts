import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

// ── Mock deps BEFORE importing the route module ─────────────────────────────

vi.mock('../../db/repositories/bug-analysis-reports.js', () => ({
  getBugAnalysisReportById: vi.fn(),
  listReportsByProductLine: vi.fn(async () => []),
  listReportsByProductLinePaged: vi.fn(async () => ({ data: [], total: 0 })),
}))

vi.mock('../../db/repositories/bug-fix-events.js', () => ({
  findByReport: vi.fn(async () => []),
}))

vi.mock('../../agent/analysis/analyzer.js', () => ({
  handleAnalyzeBug: vi.fn(),
}))

vi.mock('../../agent/coordinator.js', () => ({
  handleAnalysisComplete: vi.fn(async () => {}),
  checkAndTriggerHandover: vi.fn(async () => {}),
}))

import { registerBugAnalysisReportRoutes } from '../../admin/routes/bug-analysis-reports.js'
import {
  getBugAnalysisReportById,
  listReportsByProductLine,
  listReportsByProductLinePaged,
} from '../../db/repositories/bug-analysis-reports.js'
import { findByReport } from '../../db/repositories/bug-fix-events.js'
import { handleAnalyzeBug } from '../../agent/analysis/analyzer.js'
import { handleAnalysisComplete, checkAndTriggerHandover } from '../../agent/coordinator.js'

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

describe('POST /bug-reports/:id/handover', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const publishedReport = {
    ...abortedReport,
    status: 'published' as const,
  }

  it('returns 404 when report not found', async () => {
    ;(getBugAnalysisReportById as any).mockResolvedValue(null)
    const app = await buildApp()
    const res = await app.inject({ method: 'POST', url: '/bug-reports/999/handover' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ success: false, error: 'REPORT_NOT_FOUND' })
    await app.close()
  })

  it('returns 400 when id is not a number', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'POST', url: '/bug-reports/abc/handover' })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ success: false, error: 'INVALID_ID' })
    await app.close()
  })

  it.each([
    ['pending_manual'],
    ['completed'],
    ['aborted'],
  ])('returns 409 when status=%s (不允许转人工)', async status => {
    ;(getBugAnalysisReportById as any).mockResolvedValue({ ...abortedReport, status })
    const app = await buildApp()
    const res = await app.inject({ method: 'POST', url: '/bug-reports/42/handover' })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ success: false, error: 'INVALID_STATUS' })
    await app.close()
  })

  it.each([
    ['draft'],
    ['published'],
    ['pipeline_success'],
  ])('success when status=%s → calls checkAndTriggerHandover(user_requested)', async status => {
    ;(getBugAnalysisReportById as any)
      .mockResolvedValueOnce({ ...abortedReport, status })  // 前置读
      .mockResolvedValueOnce({ ...abortedReport, status: 'pending_manual' })  // handover 后的 reloaded 状态

    const app = await buildApp()
    const res = await app.inject({ method: 'POST', url: '/bug-reports/42/handover' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      success: true,
      data: { reportId: 42, status: 'pending_manual' },
    })
    expect(checkAndTriggerHandover).toHaveBeenCalledWith(42, 'user_requested', 'admin', undefined)
    await app.close()
  })

  it('passes comment to checkAndTriggerHandover when body.comment provided', async () => {
    ;(getBugAnalysisReportById as any)
      .mockResolvedValueOnce(publishedReport)
      .mockResolvedValueOnce({ ...abortedReport, status: 'pending_manual' })
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/bug-reports/42/handover',
      headers: { 'content-type': 'application/json' },
      payload: { comment: '这个方向 AI 走不通，我来改' },
    })
    expect(res.statusCode).toBe(200)
    expect(checkAndTriggerHandover).toHaveBeenCalledWith(42, 'user_requested', 'admin', {
      comment: '这个方向 AI 走不通，我来改',
    })
    await app.close()
  })

  it('ignores empty/whitespace-only comment', async () => {
    ;(getBugAnalysisReportById as any)
      .mockResolvedValueOnce(publishedReport)
      .mockResolvedValueOnce({ ...abortedReport, status: 'pending_manual' })
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/bug-reports/42/handover',
      headers: { 'content-type': 'application/json' },
      payload: { comment: '   ' },
    })
    expect(res.statusCode).toBe(200)
    expect(checkAndTriggerHandover).toHaveBeenCalledWith(42, 'user_requested', 'admin', undefined)
    await app.close()
  })

  it('returns 500 when checkAndTriggerHandover throws', async () => {
    ;(getBugAnalysisReportById as any).mockResolvedValue(publishedReport)
    ;(checkAndTriggerHandover as any).mockRejectedValueOnce(new Error('DB 挂了'))
    const app = await buildApp()
    const res = await app.inject({ method: 'POST', url: '/bug-reports/42/handover' })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toMatchObject({ success: false, error: 'INTERNAL_ERROR' })
    await app.close()
  })

  it('falls back to original status when reloaded report is null', async () => {
    // 边界：极端情况下 handover 之后报告被删除（或 getById 第二次返回 null），
    // 响应里的 status 应回退到前置读到的 status（而非 throw 或返回 undefined）
    ;(getBugAnalysisReportById as any)
      .mockResolvedValueOnce(publishedReport)  // 前置读
      .mockResolvedValueOnce(null)              // reloaded 为 null

    const app = await buildApp()
    const res = await app.inject({ method: 'POST', url: '/bug-reports/42/handover' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      success: true,
      data: { reportId: 42, status: 'published' },
    })
    await app.close()
  })
})

// ============================================================
// 补充：GET /bug-analysis-reports（list）与 GET /bug-analysis-reports/:id
// ============================================================

describe('GET /bug-analysis-reports (list)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('不传 product_line_id 时走分页接口返回全部（不再 MISSING_PARAM）', async () => {
    ;(listReportsByProductLinePaged as any).mockResolvedValue({ data: [], total: 0 })
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/bug-analysis-reports' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.error).toBeUndefined()
    expect(Array.isArray(body.data)).toBe(true)
    expect(listReportsByProductLinePaged).toHaveBeenCalledWith({
      productLineId: undefined,
      issueId: undefined,
      statuses: undefined,
      levels: undefined,
      page: 1,
      limit: 20,
    })
    expect(listReportsByProductLine).not.toHaveBeenCalled()
    await app.close()
  })

  it('product_line_id=0 视为未传（Number(0) 为 falsy），不过滤产品线', async () => {
    ;(listReportsByProductLinePaged as any).mockResolvedValue({ data: [], total: 0 })
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/bug-analysis-reports?product_line_id=0' })
    expect(res.statusCode).toBe(200)
    expect(res.json().error).toBeUndefined()
    expect(listReportsByProductLinePaged).toHaveBeenCalledWith(
      expect.objectContaining({ productLineId: undefined }),
    )
    await app.close()
  })

  it('传 product_line_id 时按产品线过滤，走分页接口默认 pageSize=20', async () => {
    ;(listReportsByProductLinePaged as any).mockResolvedValue({
      data: [{ id: 1 }, { id: 2 }],
      total: 2,
    })
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/bug-analysis-reports?product_line_id=7' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ data: [{ id: 1 }, { id: 2 }], total: 2, page: 1, pageSize: 20 })
    expect(listReportsByProductLinePaged).toHaveBeenCalledWith({
      productLineId: 7,
      issueId: undefined,
      statuses: undefined,
      levels: undefined,
      page: 1,
      limit: 20,
    })
    expect(listReportsByProductLine).not.toHaveBeenCalled()
    await app.close()
  })

  it('传 issueId 时转发给 repo 作为 issueId 过滤条件', async () => {
    ;(listReportsByProductLinePaged as any).mockResolvedValue({
      data: [{ id: 10, issue_id: 42 }, { id: 11, issue_id: 42 }],
      total: 2,
    })
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/bug-analysis-reports?issueId=42' })
    expect(res.statusCode).toBe(200)
    expect(listReportsByProductLinePaged).toHaveBeenCalledWith(
      expect.objectContaining({ issueId: 42 }),
    )
    const body = res.json()
    expect(body.data.every((r: any) => r.issue_id === 42)).toBe(true)
    await app.close()
  })

  it('返回字段含 product_line_name', async () => {
    ;(listReportsByProductLinePaged as any).mockResolvedValue({
      data: [{ id: 1, product_line_name: 'PAM' }],
      total: 1,
    })
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/bug-analysis-reports' })
    const body = res.json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0]).toHaveProperty('product_line_name')
    expect(body.data[0].product_line_name).toBe('PAM')
    await app.close()
  })

  it('返回字段含 completed_at（未完成时为 null）', async () => {
    ;(listReportsByProductLinePaged as any).mockResolvedValue({
      data: [{ id: 1, completed_at: null }],
      total: 1,
    })
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/bug-analysis-reports' })
    const body = res.json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0]).toHaveProperty('completed_at')
    expect(body.data[0].completed_at).toBeNull()
    await app.close()
  })

  it('传 page 参数时正确透传，pageSize 默认 20', async () => {
    ;(listReportsByProductLinePaged as any).mockResolvedValue({
      data: [{ id: 9 }],
      total: 123,
    })
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/bug-analysis-reports?product_line_id=7&page=2',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toMatchObject({ data: [{ id: 9 }], total: 123, page: 2, pageSize: 20 })
    expect(listReportsByProductLinePaged).toHaveBeenCalledWith({
      productLineId: 7,
      issueId: undefined,
      statuses: undefined,
      levels: undefined,
      page: 2,
      limit: 20,
    })
    await app.close()
  })

  it('pageSize 自定义，且被 clamp 到 [1,100]', async () => {
    ;(listReportsByProductLinePaged as any).mockResolvedValue({ data: [], total: 0 })
    const app = await buildApp()

    await app.inject({
      method: 'GET',
      url: '/bug-analysis-reports?product_line_id=7&pageSize=500',
    })
    expect(listReportsByProductLinePaged).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: 100 }),
    )

    // pageSize=0 或非数值 → `|| 20` 回退默认值，而不是被 clamp 到 1
    await app.inject({
      method: 'GET',
      url: '/bug-analysis-reports?product_line_id=7&pageSize=0',
    })
    expect(listReportsByProductLinePaged).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: 20 }),
    )

    // 但真正的负数（-5）经过 Math.max(1, ...) 会被 clamp 到 1
    await app.inject({
      method: 'GET',
      url: '/bug-analysis-reports?product_line_id=7&pageSize=-5',
    })
    // Number('-5') = -5（truthy），然后 Math.max(1, Math.min(100, -5)) = Math.max(1, -5) = 1
    expect(listReportsByProductLinePaged).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: 1 }),
    )

    await app.close()
  })

  it('page 低于 1 时回退到 1（Math.max(1, ...)）', async () => {
    ;(listReportsByProductLinePaged as any).mockResolvedValue({ data: [], total: 0 })
    const app = await buildApp()
    await app.inject({
      method: 'GET',
      url: '/bug-analysis-reports?product_line_id=7&page=-5',
    })
    expect(listReportsByProductLinePaged).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1 }),
    )
    await app.close()
  })

  it('status CSV 筛选：合法值通过，非法值被过滤', async () => {
    ;(listReportsByProductLinePaged as any).mockResolvedValue({ data: [], total: 0 })
    const app = await buildApp()
    await app.inject({
      method: 'GET',
      url: '/bug-analysis-reports?product_line_id=7&status=draft,bogus,published, ,completed',
    })
    expect(listReportsByProductLinePaged).toHaveBeenCalledWith(
      expect.objectContaining({
        statuses: ['draft', 'published', 'completed'],
        levels: undefined,
      }),
    )
    await app.close()
  })

  it('level CSV 筛选：合法值通过，非法值被过滤', async () => {
    ;(listReportsByProductLinePaged as any).mockResolvedValue({ data: [], total: 0 })
    const app = await buildApp()
    await app.inject({
      method: 'GET',
      url: '/bug-analysis-reports?product_line_id=7&level=l1,l9,l4',
    })
    expect(listReportsByProductLinePaged).toHaveBeenCalledWith(
      expect.objectContaining({
        levels: ['l1', 'l4'],
        statuses: undefined,
      }),
    )
    await app.close()
  })

  it('status/level 全部非法 → 视为 undefined（未过滤），依然走分页接口', async () => {
    ;(listReportsByProductLinePaged as any).mockResolvedValue({ data: [], total: 0 })
    const app = await buildApp()
    await app.inject({
      method: 'GET',
      url: '/bug-analysis-reports?product_line_id=7&status=bogus&level=xxx',
    })
    expect(listReportsByProductLinePaged).toHaveBeenCalledWith(
      expect.objectContaining({
        productLineId: 7,
        statuses: undefined,
        levels: undefined,
      }),
    )
    expect(listReportsByProductLine).not.toHaveBeenCalled()
    await app.close()
  })

  it('空字符串 status/level → undefined，依然走分页接口', async () => {
    ;(listReportsByProductLinePaged as any).mockResolvedValue({ data: [], total: 0 })
    const app = await buildApp()
    await app.inject({
      method: 'GET',
      url: '/bug-analysis-reports?product_line_id=7&status=&level=',
    })
    expect(listReportsByProductLinePaged).toHaveBeenCalledWith(
      expect.objectContaining({
        statuses: undefined,
        levels: undefined,
      }),
    )
    expect(listReportsByProductLine).not.toHaveBeenCalled()
    await app.close()
  })

  it('只传 level 不传 page：仍走分页接口（statuses/levels 任意非空）', async () => {
    ;(listReportsByProductLinePaged as any).mockResolvedValue({ data: [], total: 0 })
    const app = await buildApp()
    await app.inject({
      method: 'GET',
      url: '/bug-analysis-reports?product_line_id=7&level=l2',
    })
    expect(listReportsByProductLinePaged).toHaveBeenCalledWith(
      expect.objectContaining({
        levels: ['l2'],
        page: 1,
        limit: 20,
      }),
    )
    await app.close()
  })
})

describe('GET /bug-analysis-reports/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('200 返回 report 数据', async () => {
    ;(getBugAnalysisReportById as any).mockResolvedValue({ id: 42, status: 'published' })
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/bug-analysis-reports/42' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ data: { id: 42, status: 'published' } })
    expect(getBugAnalysisReportById).toHaveBeenCalledWith(42)
    await app.close()
  })

  it('未找到时返回 NOT_FOUND error（body 里带 error，非 4xx）', async () => {
    ;(getBugAnalysisReportById as any).mockResolvedValue(null)
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/bug-analysis-reports/999' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } })
    await app.close()
  })
})
