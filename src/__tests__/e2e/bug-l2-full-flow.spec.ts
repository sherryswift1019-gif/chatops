/**
 * Task 18 Phase 3A — 场景 2：L2 代码缺陷 全链路
 *
 * 和 L1 full-flow 类似，但 level=l2，走 "L2-代码缺陷" pipeline：
 *   fix_bug_l2 → create_mr → ai_review_mr → notify_bug
 *
 * 流程：
 *   1. analyze 返回 level=l2
 *   2. L2 pipeline 顺序执行各 stage 全部成功
 *   3. pipeline_success → UI 可见 + 事件齐全
 *   4. GitLab webhook merge_request.action=merge → completed + lifecycle_sync 事件
 */
import { test, expect, type APIRequestContext } from '@playwright/test'
import { Pool } from 'pg'
import { resetPerTest, seedClaudeMock } from './helpers/per-test.js'

const GITLAB_MOCK = process.env.E2E_GITLAB_MOCK_URL ?? 'http://localhost:4001'

async function loginAsAdmin(request: APIRequestContext): Promise<void> {
  await dbQuery(`UPDATE admin_users SET must_change_password = FALSE WHERE username = 'admin'`)
  const r = await request.post('/admin/auth/login', {
    data: { username: 'admin', password: 'admin' },
  })
  expect(r.ok()).toBe(true)
}

async function dbQuery<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  try {
    const { rows } = await pool.query(sql, params)
    return rows as T[]
  } finally {
    await pool.end()
  }
}

test.describe('L2 代码缺陷 全链路', () => {
  test.beforeEach(async ({ request }) => {
    await resetPerTest(request, GITLAB_MOCK)
  })

  test('analyze → L2 pipeline → pipeline_success → MR merge → completed', async ({ request, page }) => {
    await loginAsAdmin(request)

    const plRows = await dbQuery<{ id: number }>(
      `SELECT id FROM product_lines WHERE name = 'pam'`,
    )
    expect(plRows.length).toBe(1)
    const productLineId = plRows[0].id

    // ── 1. 塞 claude mock 响应 ─────────────────────────────────────────────
    await seedClaudeMock(request, 'analyze_bug-filter', {
      involvedProjects: [
        { projectPath: 'PAM/pas-api', isPrimary: true, sourceBranch: 'test' },
      ],
      primaryProjectPath: 'PAM/pas-api',
    })
    await seedClaudeMock(request, 'analyze_bug-detail', {
      classification: 'bug',
      level: 'l2',
      confidence: 'high',
      confidenceScore: 0.88,
      rootCause: {
        type: 'code',
        summary: '空指针：用户对象未判空',
        file: 'UserService.java',
        lineRange: [42, 42],
      },
      solutions: [
        { id: 'a', summary: '加 null 判断', recommended: true, risk: 'low', effort: 'low' },
      ],
      affectedModules: ['user'],
      analysisSteps: ['读代码', '定位异常栈'],
      markdown: '# L2 分析\n空指针',
    })
    await seedClaudeMock(request, 'fix-PAM/pas-api', {
      branch: 'fix/issue-1-pas-api',
      testPassed: true,
      output: '所有测试通过',
    })
    // 创建 MR 的 iid 由 mock GitLab 自增（第一个为 1）
    await seedClaudeMock(request, 'review-1', {
      label: 'ai-approved',
      summary: 'LGTM',
    })

    // ── 2. 触发链路 ────────────────────────────────────────────────────────
    test.setTimeout(60_000)
    const dispatch = await request.post('/admin/_e2e/analyze-and-dispatch', {
      data: { productLineId, message: '线上抛 NullPointerException' },
    })
    expect(dispatch.ok()).toBe(true)
    const dispatchBody = await dispatch.json()
    expect(dispatchBody.success).toBe(true)
    const { reportId, pipelineRunId, classification, level } = dispatchBody.data as {
      reportId: number
      pipelineRunId: number
      classification: string
      level: string
    }
    expect(classification).toBe('bug')
    expect(level).toBe('l2')
    expect(reportId).toBeGreaterThan(0)
    expect(pipelineRunId).toBeGreaterThan(0)

    // ── 3. DB 断言：事件齐全 + 状态 pipeline_success ──────────────────────
    const events = await dbQuery<{ code: string; status: string; project_path: string | null }>(
      `SELECT code, status, project_path FROM bug_fix_events WHERE report_id = $1 ORDER BY id`,
      [reportId],
    )
    const codes = events.map(e => e.code)
    for (const expected of [
      'analysis',
      'scope_identified',
      'create_issue',
      'fix_attempt',
      'create_mr',
      'ai_review',
      'notify',
    ]) {
      expect(codes, `events 缺少 ${expected}`).toContain(expected)
    }

    const reportRows = await dbQuery<{ status: string; pipeline_run_id: number }>(
      `SELECT status, pipeline_run_id FROM bug_analysis_reports WHERE id = $1`,
      [reportId],
    )
    expect(reportRows[0].status).toBe('pipeline_success')
    expect(reportRows[0].pipeline_run_id).toBe(pipelineRunId)

    // ── 4. UI 断言：/bug-runs 打开，IssueCard + 关键事件 ───────────────────
    const loginResp = await page.request.post('/admin/auth/login', {
      data: { username: 'admin', password: 'admin' },
    })
    expect(loginResp.ok()).toBe(true)

    await page.goto('/bug-runs')
    const pageCard = page.locator('.ant-card').filter({ hasText: 'Bug 修复实例' }).first()
    await expect(pageCard).toBeVisible({ timeout: 10_000 })

    await pageCard.locator('.ant-select').click()
    await page.locator('.ant-select-item-option').filter({ hasText: 'PAM 特权访问管理' }).click()

    const issueCardTitle = page.locator('text=/Issue #\\d+/').first()
    await expect(issueCardTitle).toBeVisible({ timeout: 10_000 })

    // L2 等级 tag（RoundHeader 显示 level.toUpperCase()）
    await expect(page.locator('.ant-tag').filter({ hasText: /^L2$/ }).first()).toBeVisible({
      timeout: 10_000,
    })

    // Timeline 关键事件
    await expect(
      page.locator('.ant-timeline').getByText(/分析完成/).first(),
    ).toBeVisible({ timeout: 10_000 })
    await expect(
      page.locator('.ant-timeline').getByText(/MR !\d+/).first(),
    ).toBeVisible({ timeout: 10_000 })
    await expect(
      page.locator('.ant-timeline').getByText('AI Review: ai-approved'),
    ).toBeVisible({ timeout: 10_000 })

    // ── 5. GitLab webhook merge → status=completed ─────────────────────────
    const mrRows = await dbQuery<{ data: { mrIid: number } }>(
      `SELECT data FROM bug_fix_events WHERE report_id = $1 AND code = 'create_mr' AND status = 'success' LIMIT 1`,
      [reportId],
    )
    expect(mrRows.length).toBe(1)
    const mrIid = mrRows[0].data.mrIid
    expect(typeof mrIid).toBe('number')

    const mergeWebhook = await request.post('/webhook/gitlab', {
      headers: { 'x-gitlab-token': '' },
      data: {
        object_kind: 'merge_request',
        object_attributes: {
          iid: mrIid,
          title: 'fix',
          action: 'merge',
          source_branch: 'fix/issue-1-pas-api',
          target_branch: 'test',
        },
        project: { path_with_namespace: 'PAM/pas-api' },
      },
    })
    expect(mergeWebhook.ok()).toBe(true)

    const finalReport = await dbQuery<{ status: string }>(
      `SELECT status FROM bug_analysis_reports WHERE id = $1`,
      [reportId],
    )
    expect(finalReport[0].status).toBe('completed')

    const lifecycleEvents = await dbQuery<{ code: string; data: Record<string, unknown> }>(
      `SELECT code, data FROM bug_fix_events WHERE report_id = $1 AND code = 'lifecycle_sync'`,
      [reportId],
    )
    expect(lifecycleEvents.length).toBeGreaterThanOrEqual(1)
    expect(lifecycleEvents[0].data.mrAction).toBe('merge')
  })
})
