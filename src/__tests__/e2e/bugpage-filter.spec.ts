/**
 * Task 18 Phase 3B — BugRunsPage 场景 B1：列表筛选 — productLine
 *
 * [降级-BugRunsPage 无 status 筛选组件]
 * 原场景：productLine 下拉 + status 筛选双维度。
 * 实际：BugRunsPage 当前只有 productLine 下拉；status 仅作为 Tag 展示，无筛选控件。
 * 因此降级为：验证切换 productLine 下拉能改变卡片数量（含 status 多样性 DB 断言）。
 *
 * 前置：
 *   - base.sql 已建 'pam' 产品线
 *   - 本 spec 额外插入第二条 'plb' 产品线
 *   - 往两个产品线 INSERT 3 条 bug_analysis_reports（2 条 pam / 1 条 plb），
 *     状态各异（pipeline_success / aborted / draft）
 *
 * 流程：
 *   1. 打开 /bug-runs，默认 Empty（未选产品线）
 *   2. 选 PAM → 断言 2 个 IssueCard（2 条 pam 报告 issueId 不同 → 2 组）
 *   3. 切到第二产品线 → 断言 1 个 IssueCard
 *   4. 再切回 PAM → 仍 2 个 IssueCard
 *
 * DB 辅助断言：3 条 reports 的 status 分布确实多样（pipeline_success + aborted + draft）。
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

test.describe('BugRunsPage 产品线筛选', () => {
  test.beforeEach(async ({ request }) => {
    await resetPerTest(request, GITLAB_MOCK)
    // 清理第二产品线遗留（不 CASCADE 避免连带 pam 的数据）
    await dbQuery(`DELETE FROM product_lines WHERE name = 'plb-e2e'`)
  })

  test('切产品线下拉 → IssueCard 数量随之变化', async ({ request, page }) => {
    await loginAsAdmin(request)

    const pamRows = await dbQuery<{ id: number }>(
      `SELECT id FROM product_lines WHERE name = 'pam'`,
    )
    const pamId = pamRows[0].id

    // 第二产品线（仅用于切 Select 校验；不需要 capabilities / projects，
    // 因为本 spec 不跑 pipeline，只读 /admin/bug-analysis-reports）
    const plbRows = await dbQuery<{ id: number }>(
      `INSERT INTO product_lines (name, display_name, description)
       VALUES ('plb-e2e', 'PLB 测试产线', 'B1 筛选 spec')
       RETURNING id`,
    )
    const plbId = plbRows[0].id

    // 插 3 条报告：pam=2（issueId 不同 → 两组），plb=1
    await dbQuery(
      `INSERT INTO bug_analysis_reports
         (issue_id, issue_url, product_line_id, level, classification, confidence,
          confidence_score, root_cause_summary, solutions_json, status)
       VALUES
         (101, 'http://mock-gitlab/PAM/pas-api/-/issues/101', $1,
          'l1', 'bug', 'high', 0.9, 'pam 报告 A（pipeline_success）',
          '[]'::jsonb, 'pipeline_success'),
         (102, 'http://mock-gitlab/PAM/pas-api/-/issues/102', $1,
          'l2', 'bug', 'medium', 0.7, 'pam 报告 B（aborted）',
          '[]'::jsonb, 'aborted'),
         (201, 'http://mock-gitlab/PLB/xxx/-/issues/201', $2,
          'l3', 'bug', 'low', 0.4, 'plb 报告（draft）',
          '[]'::jsonb, 'draft')`,
      [pamId, plbId],
    )

    // DB 层确认 status 分布多样
    const statusRows = await dbQuery<{ status: string; cnt: string }>(
      `SELECT status, COUNT(*)::text AS cnt FROM bug_analysis_reports GROUP BY status ORDER BY status`,
    )
    const statuses = statusRows.map(r => r.status).sort()
    expect(statuses).toEqual(['aborted', 'draft', 'pipeline_success'])

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

    // 选 PAM → 2 个 IssueCard
    await pageCard.locator('.ant-select').click()
    await page.locator('.ant-select-item-option').filter({ hasText: 'PAM 特权访问管理' }).click()
    // 两个 IssueCard 标题
    await expect(page.locator('text=/Issue #101/')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('text=/Issue #102/')).toBeVisible({ timeout: 10_000 })
    // 不应出现 plb 的 201
    await expect(page.locator('text=/Issue #201/')).toHaveCount(0)

    // 切到 PLB → 1 个 IssueCard
    await pageCard.locator('.ant-select').click()
    await page.locator('.ant-select-item-option').filter({ hasText: 'PLB 测试产线' }).click()
    await expect(page.locator('text=/Issue #201/')).toBeVisible({ timeout: 10_000 })
    // pam 的两条消失
    await expect(page.locator('text=/Issue #101/')).toHaveCount(0)
    await expect(page.locator('text=/Issue #102/')).toHaveCount(0)

    // 切回 PAM → 恢复 2 条
    await pageCard.locator('.ant-select').click()
    await page.locator('.ant-select-item-option').filter({ hasText: 'PAM 特权访问管理' }).click()
    await expect(page.locator('text=/Issue #101/')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('text=/Issue #102/')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('text=/Issue #201/')).toHaveCount(0)
  })
})
