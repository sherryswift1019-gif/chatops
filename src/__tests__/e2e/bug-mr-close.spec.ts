/**
 * Task 18 Phase 3A Wave 2 — 场景 8：MR 关闭 → status=aborted
 *
 * 流程：
 *   1. 触发 L1 happy path → 到 pipeline_success（MR 已创建）
 *   2. 发送 GitLab MR close webhook（action='close'）
 *   3. handleMergeRequestEvent 把 report status 改为 aborted，并写 lifecycle_sync 事件
 *      （report 从 pipeline_success 过渡到 aborted 不会被 "终态幂等" 分支挡掉，因为
 *       issue-handler 的幂等判断仅针对 completed/aborted 两个 MR 生命周期状态）
 *   4. 断言：
 *      - DB: bug_analysis_reports.status = 'aborted'
 *      - DB: bug_fix_events 末尾含 lifecycle_sync(mrAction=close, targetStatus=aborted)
 *      - UI: BugRunsPage 状态徽标 aborted，Timeline 有 "MR close → aborted" 文案
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

test.describe('MR 关闭 → aborted', () => {
  test.beforeEach(async ({ request }) => {
    await resetPerTest(request, GITLAB_MOCK)
  })

  test('L1 pipeline_success 后 GitLab MR close webhook → status=aborted + lifecycle_sync', async ({
    request,
    page,
  }) => {
    await loginAsAdmin(request)

    const plRows = await dbQuery<{ id: number }>(
      `SELECT id FROM product_lines WHERE name = 'pam'`,
    )
    expect(plRows.length).toBe(1)
    const productLineId = plRows[0].id

    // ── 1. L1 happy path mock（复用 bug-l1-full-flow 的 mock） ────────────
    await seedClaudeMock(request, 'analyze_bug-filter', {
      involvedProjects: [
        { projectPath: 'PAM/pas-api', isPrimary: true, sourceBranch: 'test' },
      ],
      primaryProjectPath: 'PAM/pas-api',
    })
    await seedClaudeMock(request, 'analyze_bug-detail', {
      classification: 'bug',
      level: 'l1',
      confidence: 'high',
      confidenceScore: 0.9,
      rootCause: {
        type: 'config',
        summary: '配置缺失',
        file: 'app.properties',
        lineRange: [10, 10],
      },
      solutions: [
        { id: 'a', summary: '补配置', recommended: true, risk: 'low', effort: 'low' },
      ],
      affectedModules: ['config'],
      analysisSteps: ['检查配置'],
      markdown: '# L1 分析\n配置缺失',
    })
    await seedClaudeMock(request, 'fix-PAM/pas-api', {
      branch: 'fix/issue-1-pas-api',
      testPassed: true,
      output: '所有测试通过',
    })
    await seedClaudeMock(request, 'review-1', { label: 'ai-approved', summary: 'LGTM' })

    // ── 2. 触发链路 ────────────────────────────────────────────────────────
    test.setTimeout(60_000)
    const dispatch = await request.post('/admin/_e2e/analyze-and-dispatch', {
      data: { productLineId, message: 'L1 bug（后续 MR 被手动关闭）' },
    })
    expect(dispatch.ok()).toBe(true)
    const dispatchBody = await dispatch.json()
    expect(dispatchBody.success).toBe(true)
    const { reportId } = dispatchBody.data as { reportId: number }

    const successReport = await dbQuery<{ status: string }>(
      `SELECT status FROM bug_analysis_reports WHERE id = $1`,
      [reportId],
    )
    expect(successReport[0].status).toBe('pipeline_success')

    // 查 mrIid（create_mr 事件 data）
    const mrRows = await dbQuery<{ data: { mrIid: number } }>(
      `SELECT data FROM bug_fix_events WHERE report_id = $1 AND code = 'create_mr' AND status = 'success' LIMIT 1`,
      [reportId],
    )
    expect(mrRows.length).toBe(1)
    const mrIid = mrRows[0].data.mrIid
    expect(typeof mrIid).toBe('number')

    // ── 3. 发送 MR close webhook ───────────────────────────────────────────
    const closeWebhook = await request.post('/webhook/gitlab', {
      headers: { 'x-gitlab-token': '' },
      data: {
        object_kind: 'merge_request',
        object_attributes: {
          iid: mrIid,
          title: 'fix',
          action: 'close',
          source_branch: 'fix/issue-1-pas-api',
          target_branch: 'test',
        },
        project: { path_with_namespace: 'PAM/pas-api' },
      },
    })
    expect(closeWebhook.ok()).toBe(true)

    // ── 4. DB 断言：status=aborted + lifecycle_sync 事件 ──────────────────
    const finalReport = await dbQuery<{ status: string }>(
      `SELECT status FROM bug_analysis_reports WHERE id = $1`,
      [reportId],
    )
    expect(finalReport[0].status).toBe('aborted')

    const lifecycleEvents = await dbQuery<{
      code: string
      data: Record<string, unknown>
    }>(
      `SELECT code, data FROM bug_fix_events WHERE report_id = $1 AND code = 'lifecycle_sync'`,
      [reportId],
    )
    expect(lifecycleEvents.length).toBe(1)
    expect(lifecycleEvents[0].data.mrAction).toBe('close')
    expect(lifecycleEvents[0].data.targetStatus).toBe('aborted')

    // ── 5. UI 断言：aborted 徽标 + lifecycle_sync 时间线文案 ───────────────
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

    // aborted 徽标（RoundHeader 里的 Tag）
    await expect(
      page.locator('.ant-tag').filter({ hasText: /^aborted$/ }).first(),
    ).toBeVisible({ timeout: 10_000 })

    // Timeline 里有 "MR close → aborted"（EventContent lifecycle_sync 分支）
    await expect(
      page.locator('.ant-timeline').getByText(/MR close → aborted/),
    ).toBeVisible({ timeout: 10_000 })
  })
})
