/**
 * BugRunsPage 筛选（productLine + status + level） — 适配 Table + Drawer UI
 *
 * 保留后端 API 侧测试（status / level / 多选），前端 UI 测试改为 Table 行数 + URL query sync。
 *
 * seed：
 *   pam: 3 条（pipeline_success L1 / aborted L1 / aborted L3）
 *   plb-e2e: 1 条（draft L3）
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

  test('前端 UI：productLine + status + level 叠加筛选 + URL query sync', async ({ request, page }) => {
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

    // 3 个 Select 按渲染顺序：产品线 / 状态 / 等级（用 nth 固定，避免 placeholder 随 value 变化而失效）
    const plSelect = pageCard.locator('.ant-select').nth(0)
    const statusSelect = pageCard.locator('.ant-select').nth(1)
    const levelSelect = pageCard.locator('.ant-select').nth(2)

    const rows = pageCard.locator('.ant-table-tbody tr.ant-table-row')

    // 无筛选：4 行（pam 3 + plb 1）
    await expect(rows).toHaveCount(4, { timeout: 10_000 })

    // 选产品线 PAM → URL 带 productLine=<id>
    await plSelect.click()
    await page.locator('.ant-select-item-option').filter({ hasText: 'PAM 特权访问管理' }).click()
    await expect(page).toHaveURL(new RegExp(`productLine=${pamId}`))
    // PAM 下 3 条
    await expect(rows).toHaveCount(3, { timeout: 10_000 })

    // 叠加 status=aborted → URL 同时带两个参数 → 2 条
    await statusSelect.click()
    await page.locator('.ant-select-item-option').filter({ hasText: /^aborted$/ }).click()
    await page.keyboard.press('Escape')
    await expect(page).toHaveURL(
      new RegExp(`(productLine=${pamId}.*status=aborted|status=aborted.*productLine=${pamId})`),
    )
    await expect(rows).toHaveCount(2, { timeout: 10_000 })

    // 再叠加 level=L1 → URL 同时带三个参数 → 1 条
    await levelSelect.click()
    await page.locator('.ant-select-item-option').filter({ hasText: /^L1$/ }).click()
    await page.keyboard.press('Escape')
    await expect(page).toHaveURL(/level=l1/)
    await expect(rows).toHaveCount(1, { timeout: 10_000 })

    // 清掉 level / status → 回到 PAM 3 条
    await levelSelect.locator('.ant-select-clear').click({ force: true })
    await statusSelect.locator('.ant-select-clear').click({ force: true })
    await expect(rows).toHaveCount(3, { timeout: 10_000 })

    // 切 PLB → 1 条
    await plSelect.click()
    await page.locator('.ant-select-item-option').filter({ hasText: 'PLB 测试产线' }).click()
    await expect(page).toHaveURL(new RegExp(`productLine=${plbId}`))
    await expect(rows).toHaveCount(1, { timeout: 10_000 })
  })

  test('URL 直接带筛选参数进入时筛选生效', async ({ request, page }) => {
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

    const loginResp = await page.request.post('/admin/auth/login', {
      data: { username: 'admin', password: 'admin' },
    })
    expect(loginResp.ok()).toBe(true)

    // URL 直接带 status=aborted → 应展示 2 条，全部是 aborted
    await page.goto('/bug-runs?status=aborted')
    const pageCard = page.locator('.ant-card').filter({ hasText: 'Bug 修复实例' }).first()
    await expect(pageCard).toBeVisible({ timeout: 10_000 })

    const rows = pageCard.locator('.ant-table-tbody tr.ant-table-row')
    await expect(rows).toHaveCount(2, { timeout: 10_000 })

    // 每行状态列都是 "已终止"（aborted 的展示文案）
    const statusCol = pageCard.locator('.ant-table-tbody tr.ant-table-row .ant-tag').filter({
      hasText: /已终止/,
    })
    await expect(statusCol).toHaveCount(2)
  })
})
