/**
 * BugRunsPage 详情 Drawer — 适配 Table + Drawer UI
 *
 * 文件名保留（bugpage-report-modal.spec.ts）避免 rename noise，但现在断言的是 Drawer。
 *
 * 流程：
 *   1. 插一条 bug_analysis_report + 一条 analysis 事件
 *   2. 打开 /bug-runs → 首行可见
 *   3. 点首行"详情"按钮 → Drawer 打开
 *   4. 断言 Drawer 内：
 *      - Section 1 "基础元数据" + Issue 链接（href + target=_blank）
 *      - Section 5 Timeline 首条事件（analysis）可见
 *      - Issue 链接 target=_blank
 */
import { test, expect, type APIRequestContext } from '@playwright/test'
import { Pool } from 'pg'
import { resetPerTest } from './helpers/per-test.js'

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

test.describe('BugRunsPage 详情 Drawer', () => {
  test.beforeEach(async ({ request }) => {
    await resetPerTest(request, GITLAB_MOCK)
  })

  test('点击"详情"按钮打开 Drawer，展示 5 个 Section', async ({ request, page }) => {
    await loginAsAdmin(request)

    const plRows = await dbQuery<{ id: number }>(
      `SELECT id FROM product_lines WHERE name = 'pam'`,
    )
    const productLineId = plRows[0].id

    const issueId = 777
    const issueUrl = `http://mock-gitlab/PAM/pas-api/-/issues/${issueId}`
    const rootCause = '配置项 db.pool.maxSize 缺失导致连接耗尽'
    const reportRows = await dbQuery<{ id: number }>(
      `INSERT INTO bug_analysis_reports
         (issue_id, issue_url, product_line_id, level, classification, confidence,
          confidence_score, root_cause_summary, solutions_json, status, primary_project_path)
       VALUES ($1, $2, $3, 'l1', 'bug', 'high', 0.95, $4,
         '[{"id":"a","summary":"补配置","recommended":true,"risk":"low","effort":"low"}]'::jsonb,
         'pipeline_success', 'PAM/pas-api')
       RETURNING id`,
      [issueId, issueUrl, productLineId, rootCause],
    )
    const reportId = reportRows[0].id

    // 塞一条 analysis 事件以保证 Drawer Section 5 的 Timeline 非空
    await dbQuery(
      `INSERT INTO bug_fix_events (report_id, project_path, code, status, data)
       VALUES ($1, NULL, 'analysis', 'success', '{"level":"l1","classification":"bug"}'::jsonb)`,
      [reportId],
    )

    const loginResp = await page.request.post('/admin/auth/login', {
      data: { username: 'admin', password: 'admin' },
    })
    expect(loginResp.ok()).toBe(true)

    await page.goto('/bug-runs')
    const pageCard = page.locator('.ant-card').filter({ hasText: 'Bug 修复实例' }).first()
    await expect(pageCard).toBeVisible({ timeout: 10_000 })

    const rows = pageCard.locator('.ant-table-tbody tr.ant-table-row')
    await expect(rows.first()).toBeVisible({ timeout: 10_000 })
    await expect(rows).toHaveCount(1)

    // 点首行"详情"按钮
    await rows.first().getByRole('button', { name: '详情' }).click()

    const drawer = page.locator('.ant-drawer-content')
    await expect(drawer).toBeVisible({ timeout: 10_000 })

    // Drawer title：Bug 报告 #<id>
    await expect(drawer.getByText(`Bug 报告 #${reportId}`)).toBeVisible()

    // Section 1 基础元数据
    await expect(drawer.getByRole('heading', { name: '基础元数据' })).toBeVisible()
    // Issue 链接（target=_blank + href）
    const issueLink = drawer.locator(`a[href="${issueUrl}"]`).first()
    await expect(issueLink).toBeVisible()
    await expect(issueLink).toHaveAttribute('target', '_blank')

    // Section 2 分析内容（根因摘要）
    await expect(drawer.getByRole('heading', { name: '分析内容' })).toBeVisible()
    await expect(drawer.getByText(rootCause).first()).toBeVisible()

    // Section 3 执行结果
    await expect(drawer.getByRole('heading', { name: '执行结果' })).toBeVisible()

    // Section 5 本轮完整事件时间线（至少 1 条 timeline item = analysis）
    await expect(drawer.getByRole('heading', { name: '本轮完整事件时间线' })).toBeVisible()
    await expect(drawer.locator('.ant-timeline-item').first()).toBeVisible()
    await expect(drawer.locator('.ant-timeline-item')).toHaveCount(1)
  })
})
