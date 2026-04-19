/**
 * Task 18 Phase 3B — BugRunsPage 场景 B2：服务端分页
 *
 * 前端默认 pageSize = 20；后端 /admin/bug-analysis-reports 支持 page/pageSize query。
 *
 * 流程：
 *   1. 插 25 条 bug_analysis_reports（issueId 各异 → 每条对应一个 IssueCard）
 *   2. 打开 /bug-runs，选 PAM → 第 1 页展示 20 张 IssueCard
 *   3. 断言页面存在 .ant-pagination 分页器
 *   4. 点"下一页" → 展示第 21-25 条（5 张 IssueCard）
 *   5. 点"上一页" → 回到第 1 页（20 张 IssueCard）
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

  test('25 条报告，pageSize=20 → 第 1 页 20，第 2 页 5，翻页正常', async ({ request, page }) => {
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

    await page.goto('/bug-runs')
    const pageCard = page.locator('.ant-card').filter({ hasText: 'Bug 修复实例' }).first()
    await expect(pageCard).toBeVisible({ timeout: 10_000 })

    // 产品线下拉是第 1 个 Select
    await pageCard.locator('.ant-select').first().click()
    await page.locator('.ant-select-item-option').filter({ hasText: 'PAM 特权访问管理' }).click()

    // 等首条 IssueCard 渲染（第 1 页最新的 1025）
    await expect(page.locator('text=/Issue #1025/')).toBeVisible({ timeout: 15_000 })

    // 分页器应存在
    const pagination = page.locator('.ant-pagination').first()
    await expect(pagination).toBeVisible({ timeout: 10_000 })

    // 第 1 页：20 张 IssueCard（1025..1006，DESC 排序）
    // 第 2 页：5 张 IssueCard（1005..1001）
    await expect(page.locator('text=/Issue #1006/')).toBeVisible()

    const issueCardsPage1 = pageCard.locator('.ant-card-small')
    await expect(issueCardsPage1).toHaveCount(20)

    // 点"下一页"
    await pagination.locator('.ant-pagination-next').click()

    // 第 2 页：5 张 IssueCard（1005..1001）
    await expect(page.locator('text=/Issue #1005/')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('text=/Issue #1001/')).toBeVisible()
    await expect(page.locator('text=/Issue #1025/')).toHaveCount(0)

    const issueCardsPage2 = pageCard.locator('.ant-card-small')
    await expect(issueCardsPage2).toHaveCount(5)

    // 点"上一页"回到第 1 页
    await pagination.locator('.ant-pagination-prev').click()
    await expect(page.locator('text=/Issue #1025/')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('text=/Issue #1001/')).toHaveCount(0)

    const issueCardsBack = pageCard.locator('.ant-card-small')
    await expect(issueCardsBack).toHaveCount(20)
  })
})
