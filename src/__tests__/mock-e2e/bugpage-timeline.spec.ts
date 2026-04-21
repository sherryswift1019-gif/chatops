/**
 * BugRunsPage Drawer 内 Timeline 展示 — 适配 Table + Drawer UI
 *
 * 流程：
 *   1. SQL 直接注入 1 条 bug_analysis_report + 8 条 bug_fix_events
 *   2. 打开 /bug-runs，点首行"详情"→ Drawer 打开
 *   3. 断言 Drawer Section 5（本轮完整事件时间线）渲染 8 个 .ant-timeline-item
 *   4. 断言每个 code 的 tag 文本（分析 / 识别 scope / 创建 Issue / 修复尝试 /
 *      创建 MR / AI Review / 通知 / 生命周期同步）都出现在 Timeline 内
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

test.describe('BugRunsPage Drawer Timeline 展示', () => {
  test.beforeEach(async ({ request }) => {
    await resetPerTest(request, GITLAB_MOCK)
  })

  test('SQL 注入 8 条事件 → Drawer Timeline 渲染全部', async ({ request, page }) => {
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
    // 对应 Drawer.CODE_LABELS：
    //   analysis / scope_identified / create_issue / fix_attempt /
    //   create_mr / ai_review / notify / lifecycle_sync
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
        data: { iid: 42, url: 'http://mock-gitlab/PAM/pas-api/-/issues/42', isReused: false },
      },
      { code: 'fix_attempt', status: 'success', projectPath: 'PAM/pas-api', data: { attempt: 1, branch: 'fix/x' } },
      {
        code: 'create_mr',
        status: 'success',
        projectPath: 'PAM/pas-api',
        data: { iid: 7, url: 'http://mock-gitlab/PAM/pas-api/-/merge_requests/7' },
      },
      { code: 'ai_review', status: 'success', projectPath: 'PAM/pas-api', data: { label: 'ai-approved' } },
      { code: 'notify', status: 'success', projectPath: null, data: { kind: 'success', targets: ['u-primary'] } },
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

    const rows = pageCard.locator('.ant-table-tbody tr.ant-table-row')
    await expect(rows.first()).toBeVisible({ timeout: 10_000 })

    // 点首行"详情"
    await rows.first().getByRole('button', { name: '详情' }).click()

    const drawer = page.locator('.ant-drawer-content')
    await expect(drawer).toBeVisible({ timeout: 10_000 })

    // Section 5: 本轮完整事件时间线
    await expect(drawer.getByRole('heading', { name: '本轮完整事件时间线' })).toBeVisible()

    // Section 5 的 Timeline 定位：Drawer 内最后一个 .ant-timeline（最靠近 Section 5 标题）
    // 实际上 Section 3 的执行结果使用 Descriptions/Card 而不是 Timeline，所以 Drawer 内
    // 只有一个外层 Timeline（来自 FullTimelineSection）。保险用 last()。
    const fullTimeline = drawer.locator('.ant-timeline').last()
    await expect(fullTimeline.locator('.ant-timeline-item')).toHaveCount(8, { timeout: 10_000 })

    // 每个 code 的 CODE_LABELS 文本都出现在 Timeline 中
    const expectedLabels = ['分析', '识别 scope', '创建 Issue', '修复尝试', '创建 MR', 'AI Review', '通知', '生命周期同步']
    for (const label of expectedLabels) {
      await expect(
        fullTimeline.locator('.ant-tag').filter({ hasText: new RegExp(`^${label}$`) }).first(),
      ).toBeVisible()
    }
  })
})
