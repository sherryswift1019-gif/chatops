/**
 * handover-mvp V1 AC5 — 非 bug 分类直接 completed，不启动 Pipeline，不发 DM。
 *
 * 覆盖：触发人报的问题经 analyzer 判定为非 bug（usage_issue / config_issue），
 * analyzer 内部直接 updateReportStatus('completed')，handleAnalysisComplete 遇
 * classification !== 'bug' 立即 return，coordinator 不启动 Pipeline、不触发 handover。
 *
 * 断言：
 *   - report.status='completed'（不是 pipeline_success / pending_manual / aborted）
 *   - 没有任何 fix_attempt / create_mr / ai_review 事件
 *   - 没有任何 handover 事件（不走 checkAndTriggerHandover）
 *   - 没有任何 notify 事件 + 没有任何 DM 记录（analyzer 对非 bug 不发通知）
 *   - UI 前端列表页该 report 的 status Tag 显示 'completed'
 */
import { test, expect, type APIRequestContext } from '@playwright/test'
import { Pool } from 'pg'
import { resetPerTest, seedClaudeMock } from './helpers/per-test.js'

const GITLAB_MOCK = process.env.E2E_GITLAB_MOCK_URL ?? 'http://localhost:4001'

async function dbQuery<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  try {
    const { rows } = await pool.query(sql, params)
    return rows as T[]
  } finally {
    await pool.end()
  }
}

async function loginAsAdmin(request: APIRequestContext): Promise<void> {
  await dbQuery(`UPDATE admin_users SET must_change_password = FALSE WHERE username = 'admin'`)
  const r = await request.post('/admin/auth/login', {
    data: { username: 'admin', password: 'admin' },
  })
  expect(r.ok()).toBe(true)
}

interface RecordedMessage {
  kind: 'group' | 'direct' | 'card'
  to: string
  text?: string
  timestamp: number
}

async function fetchMessages(
  request: APIRequestContext,
  filter: { kind?: string; to?: string } = {},
): Promise<RecordedMessage[]> {
  const qs = new URLSearchParams()
  if (filter.kind) qs.set('kind', filter.kind)
  if (filter.to) qs.set('to', filter.to)
  const r = await request.get(`/admin/_e2e/messages?${qs.toString()}`)
  expect(r.ok()).toBe(true)
  return (await r.json()) as RecordedMessage[]
}

test.describe('非 bug 分类（config_issue / usage_issue）→ 直接 completed', () => {
  test.beforeEach(async ({ request }) => {
    await resetPerTest(request, GITLAB_MOCK)
  })

  test('classification=usage_issue → status=completed + 无 Pipeline/handover/DM', async ({
    request,
    page,
  }) => {
    await loginAsAdmin(request)

    const plRows = await dbQuery<{ id: number }>(
      `SELECT id FROM product_lines WHERE name = 'pam'`,
    )
    expect(plRows.length).toBe(1)
    const productLineId = plRows[0].id

    // ── 1. Claude mock：filter 返回 1 个 project，detail 返回 usage_issue ─
    // analyzer 对 classification !== 'bug' 的 project 不会再生成 scope_identified / create_issue 事件，
    // 因此仅需要返回合法 detail JSON 即可（markdown 字段用于日志，不影响链路）。
    await seedClaudeMock(request, 'analyze_bug-filter', {
      involvedProjects: [
        { projectPath: 'PAM/pas-api', isPrimary: true, sourceBranch: 'test' },
      ],
      primaryProjectPath: 'PAM/pas-api',
    })
    await seedClaudeMock(request, 'analyze_bug-detail', {
      classification: 'usage_issue',
      level: 'l1',
      confidence: 'high',
      confidenceScore: 0.9,
      rootCause: {
        type: 'usage',
        summary: '用户配置方式错误，按文档 X 修改即可',
        file: '-',
        lineRange: [0, 0],
      },
      solutions: [
        { id: 'a', summary: '看文档 X 配置', recommended: true, risk: 'low', effort: 'low' },
      ],
      affectedModules: [],
      analysisSteps: ['确认非 bug'],
      markdown: '# 非 bug 分析\n此问题是使用方式引起，请按文档操作',
    })

    // ── 2. 触发链路 ────────────────────────────────────────────────────
    test.setTimeout(60_000)
    const dispatch = await request.post('/admin/_e2e/analyze-and-dispatch', {
      data: { productLineId, message: '某接口 403 是不是权限配错了？' },
    })
    expect(dispatch.ok()).toBe(true)
    const dispatchBody = await dispatch.json()
    expect(dispatchBody.success).toBe(true)
    const { reportId, classification, level, pipelineRunId } = dispatchBody.data as {
      reportId: number
      classification: string
      level: string
      pipelineRunId: number | undefined
    }
    expect(classification).toBe('usage_issue')
    expect(level).toBe('l1')
    // 非 bug 不启 Pipeline，pipelineRunId 不应返回
    expect(pipelineRunId).toBeUndefined()

    // ── 3. DB 断言 ────────────────────────────────────────────────────
    // 3.1 report.status='completed'
    const reportRows = await dbQuery<{ status: string; pipeline_run_id: number | null }>(
      `SELECT status, pipeline_run_id FROM bug_analysis_reports WHERE id = $1`,
      [reportId],
    )
    expect(reportRows[0].status).toBe('completed')
    expect(reportRows[0].pipeline_run_id).toBeNull()

    // 3.2 事件流：应只有 analysis 事件（非 bug 不写 scope_identified / create_issue）
    const events = await dbQuery<{ code: string; status: string }>(
      `SELECT code, status FROM bug_fix_events WHERE report_id = $1 ORDER BY id`,
      [reportId],
    )
    const codes = events.map(e => e.code)
    expect(codes).toContain('analysis')
    // 非 bug 不应有任何 pipeline / handover / 通知相关事件
    expect(codes).not.toContain('scope_identified')
    expect(codes).not.toContain('create_issue')
    expect(codes).not.toContain('fix_attempt')
    expect(codes).not.toContain('create_mr')
    expect(codes).not.toContain('ai_review')
    expect(codes).not.toContain('handover')
    expect(codes).not.toContain('notify')
    expect(codes).not.toContain('approval')

    // ── 4. DM 断言：完全没有任何消息发出 ──────────────────────────────
    const allMessages = await fetchMessages(request)
    expect(allMessages.length).toBe(0)

    // ── 5. UI：BugRunsPage 展示 status=completed ──────────────────────
    const loginResp = await page.request.post('/admin/auth/login', {
      data: { username: 'admin', password: 'admin' },
    })
    expect(loginResp.ok()).toBe(true)

    await page.goto(`/bug-runs?productLine=${productLineId}`)
    const pageCard = page.locator('.ant-card').filter({ hasText: 'Bug 修复实例' }).first()
    await expect(pageCard).toBeVisible({ timeout: 10_000 })

    // Table + Drawer 新 UI：非 bug 仍然生成 report 行，status=completed
    const firstRow = pageCard.locator('.ant-table-tbody tr.ant-table-row').first()
    await expect(firstRow).toBeVisible({ timeout: 10_000 })
    // 中文「已完成」tag 可见
    await expect(
      pageCard.locator('.ant-table-tbody .ant-tag').filter({ hasText: /已完成/ }).first(),
    ).toBeVisible({ timeout: 10_000 })
  })
})
