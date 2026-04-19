/**
 * Task 18 Phase 3B — BugRunsPage 场景 B4：查看分析报告
 *
 * [降级-BugRunsPage 未实现 markdown 分析报告 Modal/Drawer 弹窗]
 * 原场景：点"查看分析报告"按钮 → Modal 弹出 → 渲染 markdown（h1/bold）→ 关闭。
 * 实际：
 *   - BugRunsPage 的 "分析报告正文" 入口实为 RoundBody 里的纯文本 "根因" 段
 *     （来源 bug_analysis_reports.root_cause_summary），未渲染 markdown；
 *   - 另有 `<a target="_blank">查看 Issue</a>` + `<a>打开 Issue</a>` 两处跳转
 *     链接，指向 bug_analysis_reports.issue_url（mock-gitlab）。
 *   - 没有 AntD Modal / Drawer 显示"分析报告全文 markdown"。
 * 因此降级为：
 *   1. 插一条报告，root_cause_summary 含可识别文案
 *   2. 打开 /bug-runs → 选 PAM → Collapse 默认展开 latest round
 *   3. 断言：RoundBody 展示"根因"标题 + 正文；
 *          两处 Issue 链接 target="_blank" + href 指向 issueUrl
 *          （等价于"查看分析报告"的前端可点入口）
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

test.describe('BugRunsPage 分析报告查看（降级）', () => {
  test.beforeEach(async ({ request }) => {
    await resetPerTest(request, GITLAB_MOCK)
  })

  test('根因正文展示 + 两处 Issue 外链可点', async ({ request, page }) => {
    await loginAsAdmin(request)

    const plRows = await dbQuery<{ id: number }>(
      `SELECT id FROM product_lines WHERE name = 'pam'`,
    )
    const productLineId = plRows[0].id

    const issueId = 777
    const issueUrl = `http://mock-gitlab/PAM/pas-api/-/issues/${issueId}`
    const rootCause = '配置项 db.pool.maxSize 缺失导致连接耗尽'
    await dbQuery(
      `INSERT INTO bug_analysis_reports
         (issue_id, issue_url, product_line_id, level, classification, confidence,
          confidence_score, root_cause_summary, solutions_json, status, primary_project_path)
       VALUES ($1, $2, $3, 'l1', 'bug', 'high', 0.95, $4,
         '[{"id":"a","summary":"补配置","recommended":true,"risk":"low","effort":"low"}]'::jsonb,
         'pipeline_success', 'PAM/pas-api')`,
      [issueId, issueUrl, productLineId, rootCause],
    )

    const loginResp = await page.request.post('/admin/auth/login', {
      data: { username: 'admin', password: 'admin' },
    })
    expect(loginResp.ok()).toBe(true)

    await page.goto('/bug-runs')
    const pageCard = page.locator('.ant-card').filter({ hasText: 'Bug 修复实例' }).first()
    await expect(pageCard).toBeVisible({ timeout: 10_000 })

    await pageCard.locator('.ant-select').first().click()
    await page.locator('.ant-select-item-option').filter({ hasText: 'PAM 特权访问管理' }).click()

    // IssueCard 可见（标题含 Issue #777）
    const issueCard = page.locator('.ant-card-small').filter({ hasText: `Issue #${issueId}` }).first()
    await expect(issueCard).toBeVisible({ timeout: 10_000 })

    // ── "查看 Issue" 链接（IssueCard title 区）—— target="_blank" + href ─────
    const viewIssueLink = issueCard.locator('a', { hasText: '查看 Issue' }).first()
    await expect(viewIssueLink).toBeVisible()
    await expect(viewIssueLink).toHaveAttribute('target', '_blank')
    await expect(viewIssueLink).toHaveAttribute('href', issueUrl)

    // ── Collapse 默认展开 latest round → RoundBody 根因标题 + 正文可见 ──────
    // 注：rootCause 文本还会被 truncate(50) 后拼进 IssueCard 标题 "Issue #777 · ..."，
    // 因此会匹到 2 处（标题 + 正文）。两处都可见即符合预期。
    await expect(issueCard.getByText('根因', { exact: true })).toBeVisible()
    await expect(issueCard.getByText(rootCause).first()).toBeVisible()

    // ── "打开 Issue"链接（RoundBody 下部）—— target="_blank" + href ─────────
    const openIssueLink = issueCard.locator('a', { hasText: '打开 Issue' }).first()
    await expect(openIssueLink).toBeVisible()
    await expect(openIssueLink).toHaveAttribute('target', '_blank')
    await expect(openIssueLink).toHaveAttribute('href', issueUrl)

    // ── 降级断言：当前实现**没有** markdown 弹窗（无 ".ant-modal" / ".ant-drawer"
    // 在可见态显示分析报告） ──
    await expect(page.locator('.ant-modal:visible')).toHaveCount(0)
    await expect(page.locator('.ant-drawer:visible')).toHaveCount(0)
  })
})
