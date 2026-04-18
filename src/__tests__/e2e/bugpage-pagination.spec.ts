/**
 * Task 18 Phase 3B — BugRunsPage 场景 B2：分页
 *
 * [降级-BugRunsPage 无分页器 UI & 后端 API 不支持 offset/page 参数]
 * 原场景：点"下一页"翻页；pageSize 限制每页展示数量。
 * 实际：
 *   - 后端 /admin/bug-analysis-reports 只接受 limit 参数（默认 50），无 offset/page；
 *   - 前端 BugRunsPage 调 getBugAnalysisReports(productLineId, 50)（硬编码 limit=50），
 *     拉到即全部 render（groupByIssueId → Collapse），DOM 中无 .ant-pagination 组件。
 * 因此降级为「一次性加载 limit 上限内多条报告，全部渲染，不崩溃」：
 *   1. 插 25 条 bug_analysis_reports（issueId 各异 → 25 个 IssueCard）
 *   2. 打开 /bug-runs 选 PAM → 断言 25 张 IssueCard 全部 render
 *   3. 断言页面上**不存在** AntD 分页器组件（证明当前 UI 确实无分页控件）
 *
 * 如果将来加了分页器，本 spec 会在 .ant-pagination 可见处 fail，提醒更新 UI 断言。
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

test.describe('BugRunsPage 分页（降级）', () => {
  test.beforeEach(async ({ request }) => {
    await resetPerTest(request, GITLAB_MOCK)
  })

  test('插 25 条报告 → 一次性 render 25 张 IssueCard，无分页器', async ({ request, page }) => {
    await loginAsAdmin(request)

    const plRows = await dbQuery<{ id: number }>(
      `SELECT id FROM product_lines WHERE name = 'pam'`,
    )
    const productLineId = plRows[0].id

    // 批量插 25 条（issueId 从 1001 起，互不相同 → 25 个 group）
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
    // 三种状态分布（用 id 顺序 mod 3 更新，保证 pipeline_success/aborted/draft 各有）
    await dbQuery(
      `UPDATE bug_analysis_reports SET status = CASE (id % 3)
         WHEN 0 THEN 'pipeline_success'
         WHEN 1 THEN 'aborted'
         ELSE 'draft' END
       WHERE product_line_id = $1`,
      [productLineId],
    )

    // DB 确认确实插了 25 条
    const cntRows = await dbQuery<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM bug_analysis_reports WHERE product_line_id = $1`,
      [productLineId],
    )
    expect(cntRows[0].cnt).toBe(String(N))

    // ── UI ────────────────────────────────────────────────────────────────
    const loginResp = await page.request.post('/admin/auth/login', {
      data: { username: 'admin', password: 'admin' },
    })
    expect(loginResp.ok()).toBe(true)

    await page.goto('/bug-runs')
    const pageCard = page.locator('.ant-card').filter({ hasText: 'Bug 修复实例' }).first()
    await expect(pageCard).toBeVisible({ timeout: 10_000 })

    await pageCard.locator('.ant-select').click()
    await page.locator('.ant-select-item-option').filter({ hasText: 'PAM 特权访问管理' }).click()

    // 等首条 IssueCard 渲染（1001）
    await expect(page.locator('text=/Issue #1001/')).toBeVisible({ timeout: 15_000 })
    // 末条 IssueCard 渲染（1025）
    await expect(page.locator('text=/Issue #1025/')).toBeVisible({ timeout: 15_000 })

    // 断言 IssueCard 数量 = N（每条 report 对应一个 issueId → 一个 Collapse，
    // 外层套 .ant-card.ant-card-small 作为 IssueCard 容器）
    const issueCards = pageCard.locator('.ant-card-small')
    await expect(issueCards).toHaveCount(N)

    // 降级断言：当前无分页器（不存在 .ant-pagination 组件）
    await expect(page.locator('.ant-pagination')).toHaveCount(0)
  })
})
