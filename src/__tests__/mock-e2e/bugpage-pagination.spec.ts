/**
 * BugRunsPage 服务端分页 — 适配 Table + Drawer UI
 *
 * 新版 UI：Table 的 pagination（AntD 原生分页器），pageSize=20 默认。
 *
 * 流程：
 *   1. 插 25 条 bug_analysis_reports（pam 产品线）
 *   2. /bug-runs?pageSize=20 → Table 第 1 页 20 行
 *   3. 分页器展示 pageSize changer（showSizeChanger=true）
 *   4. 点 page 2 → URL 带 page=2 → Table 5 行
 *   5. 点 page 1 → 回到 20 行
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

test.describe('BugRunsPage 服务端分页', () => {
  test.beforeEach(async ({ request }) => {
    await resetPerTest(request, GITLAB_MOCK)
  })

  test('25 条报告，pageSize=20 → 第 1 页 20 行，第 2 页 5 行', async ({ request, page }) => {
    await loginAsAdmin(request)

    const plRows = await dbQuery<{ id: number }>(
      `SELECT id FROM product_lines WHERE name = 'pam'`,
    )
    const productLineId = plRows[0].id

    const N = 25
    const valuesParts: string[] = []
    const params: unknown[] = []
    for (let i = 0; i < N; i++) {
      const issueId = 1001 + i
      const base = i * 6 + 1
      valuesParts.push(
        `($${base}, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, 'bug', 'high', $${base + 5}::jsonb)`,
      )
      params.push(
        issueId,
        `http://mock-gitlab/PAM/pas-api/-/issues/${issueId}`,
        productLineId,
        'l1',
        `第 ${i + 1} 条报告`,
        '[]',
      )
    }
    await dbQuery(
      `INSERT INTO bug_analysis_reports
         (issue_id, issue_url, product_line_id, level, root_cause_summary, classification, confidence, solutions_json)
       VALUES ${valuesParts.join(', ')}`,
      params,
    )

    // DB 确认
    const cntRows = await dbQuery<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM bug_analysis_reports WHERE product_line_id = $1`,
      [productLineId],
    )
    expect(cntRows[0].cnt).toBe(String(N))

    // 后端 API 分页 sanity check
    const r1 = await request.get(
      `/admin/bug-analysis-reports?product_line_id=${productLineId}&page=1&pageSize=20`,
    )
    expect(r1.ok()).toBe(true)
    const body1 = await r1.json()
    expect(body1.total).toBe(N)
    expect(body1.data.length).toBe(20)
    expect(body1.page).toBe(1)
    expect(body1.pageSize).toBe(20)

    const r2 = await request.get(
      `/admin/bug-analysis-reports?product_line_id=${productLineId}&page=2&pageSize=20`,
    )
    expect(r2.ok()).toBe(true)
    const body2 = await r2.json()
    expect(body2.data.length).toBe(5)

    // ── UI ────────────────────────────────────────────────────────────────
    const loginResp = await page.request.post('/admin/auth/login', {
      data: { username: 'admin', password: 'admin' },
    })
    expect(loginResp.ok()).toBe(true)

    // URL 直接指定 pageSize=20
    await page.goto('/bug-runs?pageSize=20')
    const pageCard = page.locator('.ant-card').filter({ hasText: 'Bug 修复实例' }).first()
    await expect(pageCard).toBeVisible({ timeout: 10_000 })

    const rows = pageCard.locator('.ant-table-tbody tr.ant-table-row')

    // 第 1 页：20 行
    await expect(rows).toHaveCount(20, { timeout: 10_000 })

    // 分页器存在：有 2 个页码按钮（25 条 / 20 = 2 页）
    const pagination = pageCard.locator('.ant-pagination').first()
    await expect(pagination).toBeVisible()
    await expect(pagination.locator('li.ant-pagination-item')).toHaveCount(2)

    // 点 page 2
    await pagination.locator('.ant-pagination-item-2').click()
    await expect(page).toHaveURL(/page=2/)
    await expect(rows).toHaveCount(5, { timeout: 10_000 })

    // 回到 page 1
    await pagination.locator('.ant-pagination-item-1').click()
    await expect(page).toHaveURL(/page=1/)
    await expect(rows).toHaveCount(20, { timeout: 10_000 })
  })
})
