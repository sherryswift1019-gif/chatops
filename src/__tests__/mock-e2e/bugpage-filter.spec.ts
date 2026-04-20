/**
 * Task 18 Phase 3B — BugRunsPage 场景 B1：列表筛选（productLine + status + level）
 *
 * 前置：
 *   - base.sql 已建 'pam' 产品线
 *   - 本 spec 额外插入第二条 'plb' 产品线
 *   - 往两个产品线 INSERT 4 条 bug_analysis_reports：
 *       pam: 3 条（pipeline_success L1 / aborted L1 / aborted L3）
 *       plb: 1 条（draft L3）
 *
 * 流程：
 *   1. 打开 /bug-runs → 默认 Empty
 *   2. 选 PAM → 3 个 IssueCard（3 条报告）
 *   3. 叠加 status=aborted → 只剩 2 条（L1 aborted + L3 aborted）
 *   4. 再叠加 level=L1 → 只剩 1 条（L1 aborted）
 *   5. 清掉筛选，切 PLB → 只剩 1 条（draft L3）
 *   6. 切回 PAM → 恢复 3 条
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

test.describe('BugRunsPage 筛选（productLine + status + level）', () => {
  test.beforeEach(async ({ request }) => {
    await resetPerTest(request, GITLAB_MOCK)
    // 清理第二产品线遗留
    await dbQuery(`DELETE FROM product_lines WHERE name = 'plb-e2e'`)
  })

  test('后端筛选：status + level query 参数正确过滤', async ({ request }) => {
    await loginAsAdmin(request)

    const pamRows = await dbQuery<{ id: number }>(
      `SELECT id FROM product_lines WHERE name = 'pam'`,
    )
    const pamId = pamRows[0].id

    await dbQuery(
      `INSERT INTO bug_analysis_reports
         (issue_id, issue_url, product_line_id, level, classification, confidence,
          confidence_score, root_cause_summary, solutions_json, status)
       VALUES
         (101, 'http://mock-gitlab/PAM/pas-api/-/issues/101', $1,
          'l1', 'bug', 'high', 0.9, 'A (pipeline_success L1)', '[]'::jsonb, 'pipeline_success'),
         (102, 'http://mock-gitlab/PAM/pas-api/-/issues/102', $1,
          'l1', 'bug', 'medium', 0.7, 'B (aborted L1)', '[]'::jsonb, 'aborted'),
         (103, 'http://mock-gitlab/PAM/pas-api/-/issues/103', $1,
          'l3', 'bug', 'low', 0.5, 'C (aborted L3)', '[]'::jsonb, 'aborted')`,
      [pamId],
    )

    // 后端过滤 status=aborted → 2 条
    const r1 = await request.get(`/admin/bug-analysis-reports?product_line_id=${pamId}&status=aborted`)
    expect(r1.ok()).toBe(true)
    const body1 = await r1.json()
    expect(body1.total).toBe(2)
    expect(body1.data.length).toBe(2)
    for (const r of body1.data) expect(r.status).toBe('aborted')

    // 后端过滤 status=aborted&level=l1 → 1 条
    const r2 = await request.get(
      `/admin/bug-analysis-reports?product_line_id=${pamId}&status=aborted&level=l1`,
    )
    expect(r2.ok()).toBe(true)
    const body2 = await r2.json()
    expect(body2.total).toBe(1)
    expect(body2.data.length).toBe(1)
    expect(body2.data[0].level).toBe('l1')
    expect(body2.data[0].status).toBe('aborted')

    // 多选：status=aborted,pipeline_success → 3 条
    const r3 = await request.get(
      `/admin/bug-analysis-reports?product_line_id=${pamId}&status=aborted,pipeline_success`,
    )
    expect(r3.ok()).toBe(true)
    const body3 = await r3.json()
    expect(body3.total).toBe(3)
  })

  test('前端 UI：productLine + status + level 叠加筛选 IssueCard', async ({ request, page }) => {
    await loginAsAdmin(request)

    const pamRows = await dbQuery<{ id: number }>(
      `SELECT id FROM product_lines WHERE name = 'pam'`,
    )
    const pamId = pamRows[0].id

    const plbRows = await dbQuery<{ id: number }>(
      `INSERT INTO product_lines (name, display_name, description)
       VALUES ('plb-e2e', 'PLB 测试产线', 'B1 筛选 spec')
       RETURNING id`,
    )
    const plbId = plbRows[0].id

    await dbQuery(
      `INSERT INTO bug_analysis_reports
         (issue_id, issue_url, product_line_id, level, classification, confidence,
          confidence_score, root_cause_summary, solutions_json, status)
       VALUES
         (101, 'http://mock-gitlab/PAM/pas-api/-/issues/101', $1,
          'l1', 'bug', 'high', 0.9, 'A (pipeline_success L1)', '[]'::jsonb, 'pipeline_success'),
         (102, 'http://mock-gitlab/PAM/pas-api/-/issues/102', $1,
          'l1', 'bug', 'medium', 0.7, 'B (aborted L1)', '[]'::jsonb, 'aborted'),
         (103, 'http://mock-gitlab/PAM/pas-api/-/issues/103', $1,
          'l3', 'bug', 'low', 0.5, 'C (aborted L3)', '[]'::jsonb, 'aborted'),
         (201, 'http://mock-gitlab/PLB/xxx/-/issues/201', $2,
          'l3', 'bug', 'low', 0.4, 'D (draft L3)', '[]'::jsonb, 'draft')`,
      [pamId, plbId],
    )

    // ── UI ────────────────────────────────────────────────────────────────
    const loginResp = await page.request.post('/admin/auth/login', {
      data: { username: 'admin', password: 'admin' },
    })
    expect(loginResp.ok()).toBe(true)

    await page.goto('/bug-runs')
    const pageCard = page.locator('.ant-card').filter({ hasText: 'Bug 修复实例' }).first()
    await expect(pageCard).toBeVisible({ timeout: 10_000 })

    // 未选产品线 → Empty
    await expect(pageCard.getByText('请先选择产品线')).toBeVisible()

    // 第 1 个 Select 是产品线，第 2 个是 status，第 3 个是 level
    const plSelect = pageCard.locator('.ant-select').nth(0)
    const statusSelect = pageCard.locator('.ant-select').nth(1)
    const levelSelect = pageCard.locator('.ant-select').nth(2)

    // 选 PAM → 3 个 IssueCard
    await plSelect.click()
    await page.locator('.ant-select-item-option').filter({ hasText: 'PAM 特权访问管理' }).click()
    await expect(page.locator('text=/Issue #101/')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('text=/Issue #102/')).toBeVisible()
    await expect(page.locator('text=/Issue #103/')).toBeVisible()

    // 叠加 status=aborted → 只剩 102 / 103
    await statusSelect.click()
    await page.locator('.ant-select-item-option').filter({ hasText: /^aborted$/ }).click()
    // 关闭 dropdown
    await page.keyboard.press('Escape')
    await expect(page.locator('text=/Issue #102/')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('text=/Issue #103/')).toBeVisible()
    await expect(page.locator('text=/Issue #101/')).toHaveCount(0)

    // 再叠加 level=L1 → 只剩 102
    await levelSelect.click()
    await page.locator('.ant-select-item-option').filter({ hasText: /^L1$/ }).click()
    await page.keyboard.press('Escape')
    await expect(page.locator('text=/Issue #102/')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('text=/Issue #103/')).toHaveCount(0)
    await expect(page.locator('text=/Issue #101/')).toHaveCount(0)

    // 清掉 level / status 筛选
    await levelSelect.locator('.ant-select-clear').click({ force: true })
    await statusSelect.locator('.ant-select-clear').click({ force: true })
    await expect(page.locator('text=/Issue #101/')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('text=/Issue #102/')).toBeVisible()
    await expect(page.locator('text=/Issue #103/')).toBeVisible()

    // 切 PLB → 1 条
    await plSelect.click()
    await page.locator('.ant-select-item-option').filter({ hasText: 'PLB 测试产线' }).click()
    await expect(page.locator('text=/Issue #201/')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('text=/Issue #101/')).toHaveCount(0)
    await expect(page.locator('text=/Issue #102/')).toHaveCount(0)
    await expect(page.locator('text=/Issue #103/')).toHaveCount(0)

    // 切回 PAM → 恢复 3 条
    await plSelect.click()
    await page.locator('.ant-select-item-option').filter({ hasText: 'PAM 特权访问管理' }).click()
    await expect(page.locator('text=/Issue #101/')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('text=/Issue #102/')).toBeVisible()
    await expect(page.locator('text=/Issue #103/')).toBeVisible()
    await expect(page.locator('text=/Issue #201/')).toHaveCount(0)
  })
})
