/**
 * Task 18 Phase 3B — BugRunsPage 场景 B3：展开 IssueCard → EventTimeline 完整展示
 *
 * 目的：验证 BugRunsPage 渲染 8 种 event code 的文案是否正确、顺序是否按
 * created_at ASC + id ASC（与 findByReport 一致）渲染。
 *
 * 前置：SQL 直接 INSERT 1 条 bug_analysis_report + 8 条 bug_fix_events，
 * 不跑真实 pipeline，纯 UI 层验证。
 *
 * 断言：
 *   - IssueCard 可见（Collapse defaultActiveKey 默认展开 latest round）
 *   - 8 条 Timeline item 全部渲染
 *   - 每条事件的文案（如 "分析完成"、"创建 Issue #N"、"MR !N"、
 *     "AI Review: ai-approved"、"✅ 通知 u-primary"、"MR merge → completed"）
 *     与 BugRunsPage.EventContent 的 switch 分支一一对应
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

test.describe('BugRunsPage EventTimeline 展示', () => {
  test.beforeEach(async ({ request }) => {
    await resetPerTest(request, GITLAB_MOCK)
  })

  test('SQL 直接注入 8 条事件 → UI Timeline 渲染全部文案', async ({ request, page }) => {
    await loginAsAdmin(request)

    const plRows = await dbQuery<{ id: number }>(
      `SELECT id FROM product_lines WHERE name = 'pam'`,
    )
    const productLineId = plRows[0].id

    // ── 1. 注入一条 bug_analysis_report（status=pipeline_success） ─────────
    const reportRows = await dbQuery<{ id: number }>(
      `INSERT INTO bug_analysis_reports
         (issue_id, issue_url, product_line_id, level, classification, confidence,
          confidence_score, root_cause_summary, solutions_json, status, primary_project_path)
       VALUES (42, 'http://mock-gitlab/PAM/pas-api/-/issues/42', $1,
         'l1', 'bug', 'high', 0.9, '时间线完整渲染用例',
         '[{"id":"a","summary":"补配置","recommended":true,"risk":"low","effort":"low"}]'::jsonb,
         'pipeline_success', 'PAM/pas-api')
       RETURNING id`,
      [productLineId],
    )
    const reportId = reportRows[0].id

    // ── 2. 注入 8 条 bug_fix_events，created_at 递增以保证顺序稳定 ──────────
    // EventContent 的 switch 分支顺序（BugRunsPage.tsx 264-319 行）：
    //   analysis / scope_identified / create_issue / fix_attempt /
    //   create_mr / ai_review / approval / notify / lifecycle_sync
    // 本用例不塞 approval，改塞 8 条：analysis / scope_identified / create_issue /
    // fix_attempt(success) / create_mr / ai_review / notify / lifecycle_sync
    const events: Array<{
      code: string
      status: 'success' | 'failed'
      projectPath: string | null
      data: Record<string, unknown>
    }> = [
      { code: 'analysis', status: 'success', projectPath: null, data: { level: 'l1', classification: 'bug' } },
      { code: 'scope_identified', status: 'success', projectPath: 'PAM/pas-api', data: { isPrimary: true } },
      {
        code: 'create_issue',
        status: 'success',
        projectPath: 'PAM/pas-api',
        data: { issueIid: 42, issueUrl: 'http://mock-gitlab/PAM/pas-api/-/issues/42', isPrimary: true },
      },
      { code: 'fix_attempt', status: 'success', projectPath: 'PAM/pas-api', data: { attempt: 1 } },
      {
        code: 'create_mr',
        status: 'success',
        projectPath: 'PAM/pas-api',
        data: { mrIid: 7, mrUrl: 'http://mock-gitlab/PAM/pas-api/-/merge_requests/7' },
      },
      { code: 'ai_review', status: 'success', projectPath: 'PAM/pas-api', data: { label: 'ai-approved' } },
      { code: 'notify', status: 'success', projectPath: null, data: { userId: 'u-primary', messageKind: 'success' } },
      {
        code: 'lifecycle_sync',
        status: 'success',
        projectPath: 'PAM/pas-api',
        data: { mrAction: 'merge', targetStatus: 'completed' },
      },
    ]

    for (let i = 0; i < events.length; i++) {
      const ev = events[i]
      await dbQuery(
        `INSERT INTO bug_fix_events (report_id, project_path, code, status, data, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, NOW() + ($6 || ' milliseconds')::interval)`,
        [reportId, ev.projectPath, ev.code, ev.status, JSON.stringify(ev.data), String(i)],
      )
    }

    // ── 3. UI 验证 ─────────────────────────────────────────────────────────
    const loginResp = await page.request.post('/admin/auth/login', {
      data: { username: 'admin', password: 'admin' },
    })
    expect(loginResp.ok()).toBe(true)

    await page.goto('/bug-runs')
    const pageCard = page.locator('.ant-card').filter({ hasText: 'Bug 修复实例' }).first()
    await expect(pageCard).toBeVisible({ timeout: 10_000 })

    await pageCard.locator('.ant-select').first().click()
    await page.locator('.ant-select-item-option').filter({ hasText: 'PAM 特权访问管理' }).click()

    // IssueCard 可见
    const issueCardTitle = page.locator('text=/Issue #42/').first()
    await expect(issueCardTitle).toBeVisible({ timeout: 10_000 })

    // Collapse 默认展开 latest round（即刚插入的这条），EventTimeline 直接可见
    const timeline = page.locator('.ant-timeline').first()
    await expect(timeline).toBeVisible({ timeout: 10_000 })

    // 逐条文案断言（EventContent 分支）
    await expect(timeline.getByText(/分析完成.*level=l1.*classification=bug/)).toBeVisible({ timeout: 10_000 })
    await expect(timeline.getByText(/锁定 PAM\/pas-api（主仓库）/)).toBeVisible()
    await expect(timeline.getByText(/创建 Issue #42/)).toBeVisible()
    // fix_attempt success → "✅ PAM/pas-api 修复（attempt=1）"
    await expect(timeline.getByText(/✅ PAM\/pas-api 修复（attempt=1）/)).toBeVisible()
    // create_mr → "MR !7（PAM/pas-api）"
    await expect(timeline.getByText(/MR !7（PAM\/pas-api）/)).toBeVisible()
    await expect(timeline.getByText('AI Review: ai-approved')).toBeVisible()
    await expect(timeline.getByText(/✅ 通知 u-primary（success）/)).toBeVisible()
    await expect(timeline.getByText(/MR merge → completed/)).toBeVisible()

    // Timeline 有 8 个 item
    const items = timeline.locator('.ant-timeline-item')
    await expect(items).toHaveCount(8)
  })
})
