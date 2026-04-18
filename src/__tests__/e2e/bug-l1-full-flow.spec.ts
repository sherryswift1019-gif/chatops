/**
 * Task 18 Phase 2 — L1 配置类 Bug 全链路 e2e
 *
 * 场景：
 *   1. 后端触发 analyze_bug（HTTP POST /admin/_e2e/analyze-and-dispatch）
 *   2. analyzer 内部调用 mock 的 runFilterStage / runDetailStage → 分类=bug level=l1
 *   3. handleAnalysisComplete 自动按 level 匹配 "L1-配置类" Pipeline 并串行执行
 *      L1 修复 → 创建 MR → AI Review → 通知
 *   4. 断言 bug_fix_events 至少覆盖 analysis / scope_identified / create_issue /
 *      fix_attempt / create_mr / ai_review / notify；报告 status=pipeline_success
 *   5. 打开 /bug-runs UI 断言 IssueCard + EventTimeline 可见
 *   6. POST /webhook/gitlab merge_request.action=merge → status=completed +
 *      lifecycle_sync 事件写入
 *
 * Mock 约定（与 src/agent/mocks/e2e-store.ts 一致）：
 *   - `analyze_bug-filter`        filter 阶段
 *   - `analyze_bug-detail`        detail 阶段
 *   - `fix-<projectPath>`         runFixForProject
 *   - `review-<mrIid>`            runClaudeReview（iid 由 mock GitLab 自增）
 */
import { test, expect, type APIRequestContext } from '@playwright/test'
import { Pool } from 'pg'
import { resetPerTest, seedClaudeMock } from './helpers/per-test.js'

const GITLAB_MOCK = process.env.E2E_GITLAB_MOCK_URL ?? 'http://localhost:4001'

/** 登录并获取一个带 session cookie 的 APIRequestContext（用于访问 /admin/* 受保护端点 + 首次 /bug-runs 访问）。 */
async function loginAsAdmin(request: APIRequestContext): Promise<void> {
  // 先把 admin 的 must_change_password 置为 false，否则 AuthGuard 会把 page 推到
  // /change-password 并阻断后续断言。
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

test.describe('L1 配置类 Bug 全链路', () => {
  test.beforeEach(async ({ request }) => {
    await resetPerTest(request, GITLAB_MOCK)
  })

  test('analyze → L1 pipeline → pipeline_success → MR merge → completed', async ({ request, page }) => {
    // ── 0. 前置：登录（后面 UI / admin DB 查询都要 session） ──────────────────
    await loginAsAdmin(request)

    // 取得 pam 产品线 id（base.sql 已 seed）
    const plRows = await dbQuery<{ id: number }>(
      `SELECT id FROM product_lines WHERE name = 'pam'`,
    )
    expect(plRows.length).toBe(1)
    const productLineId = plRows[0].id

    // ── 1. 塞 claude mock 响应 ─────────────────────────────────────────────
    await seedClaudeMock(request, 'analyze_bug-filter', {
      involvedProjects: [
        { projectPath: 'PAM/pas-api', isPrimary: true, sourceBranch: 'test' },
      ],
      primaryProjectPath: 'PAM/pas-api',
    })
    await seedClaudeMock(request, 'analyze_bug-detail', {
      classification: 'bug',
      level: 'l1',
      confidence: 'high',
      confidenceScore: 0.9,
      rootCause: {
        type: 'config',
        summary: '配置缺失',
        file: 'app.properties',
        lineRange: [10, 10],
      },
      solutions: [
        { id: 'a', summary: '补配置', recommended: true, risk: 'low', effort: 'low' },
      ],
      affectedModules: ['config'],
      analysisSteps: ['检查配置'],
      markdown: '# L1 分析\n配置缺失',
    })
    await seedClaudeMock(request, 'fix-PAM/pas-api', {
      branch: 'fix/issue-1-pas-api',
      testPassed: true,
      output: '所有测试通过',
    })
    // 第一次 create_mr 会生成 iid=1（mock GitLab 自增 mrCounter）
    await seedClaudeMock(request, 'review-1', {
      label: 'ai-approved',
      summary: 'LGTM',
    })

    // ── 2. 触发完整链路 ────────────────────────────────────────────────────
    test.setTimeout(60_000)
    const dispatch = await request.post('/admin/_e2e/analyze-and-dispatch', {
      data: { productLineId, message: '线上 TASK_PWD_4001 报错' },
    })
    expect(dispatch.ok()).toBe(true)
    const dispatchBody = await dispatch.json()
    expect(dispatchBody.success).toBe(true)
    const { reportId, pipelineRunId, classification, level } = dispatchBody.data as {
      reportId: number
      pipelineRunId: number
      classification: string
      level: string
    }
    expect(classification).toBe('bug')
    expect(level).toBe('l1')
    expect(reportId).toBeGreaterThan(0)
    expect(pipelineRunId).toBeGreaterThan(0)

    // ── 3. DB 断言：事件齐全 + 状态 pipeline_success ──────────────────────
    const events = await dbQuery<{ code: string; status: string; project_path: string | null }>(
      `SELECT code, status, project_path FROM bug_fix_events WHERE report_id = $1 ORDER BY id`,
      [reportId],
    )
    const codes = events.map(e => e.code)
    for (const expected of [
      'analysis',
      'scope_identified',
      'create_issue',
      'fix_attempt',
      'create_mr',
      'ai_review',
      'notify',
    ]) {
      expect(codes, `events 缺少 ${expected}`).toContain(expected)
    }

    const reportRows = await dbQuery<{ status: string; pipeline_run_id: number }>(
      `SELECT status, pipeline_run_id FROM bug_analysis_reports WHERE id = $1`,
      [reportId],
    )
    expect(reportRows[0].status).toBe('pipeline_success')
    expect(reportRows[0].pipeline_run_id).toBe(pipelineRunId)

    // ── 4. UI 断言：/bug-runs 能看到 IssueCard + 关键事件 ────────────────────
    // 让 page 自己的 browser context 走一遍 login，拿到 cookie
    const loginResp = await page.request.post('/admin/auth/login', {
      data: { username: 'admin', password: 'admin' },
    })
    expect(loginResp.ok()).toBe(true)

    await page.goto('/bug-runs')
    // 等 BugRunsPage 根 Card 出现（title="Bug 修复实例"） — 避免匹到顶部 header 和 sider 菜单，
    // 用 Card 自己的 head title locator
    const pageCard = page.locator('.ant-card').filter({ hasText: 'Bug 修复实例' }).first()
    await expect(pageCard).toBeVisible({ timeout: 10_000 })

    // 点开 AntD Select（BugRunsPage 里只有一个 Select）
    await pageCard.locator('.ant-select').click()
    // 弹出下拉后选择 PAM 选项
    await page.locator('.ant-select-item-option').filter({ hasText: 'PAM 特权访问管理' }).click()

    // 等 IssueCard 渲染：标题含 "Issue #" 前缀（由 BugRunsPage.IssueCard 拼接）
    // 这里 issue 是 mock server 自增的 iid（第一次创建 issue，iid=1）
    const issueCardTitle = page.locator('text=/Issue #\\d+/').first()
    await expect(issueCardTitle).toBeVisible({ timeout: 10_000 })

    // 关键断言：timeline 中至少能看到这些文案（默认 Collapse defaultActiveKey 已展开 latest round）
    await expect(page.locator('.ant-timeline').getByText(/分析完成/).first()).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('.ant-timeline').getByText(/MR !\d+/).first()).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('.ant-timeline').getByText('AI Review: ai-approved')).toBeVisible({
      timeout: 10_000,
    })

    // ── 5. GitLab webhook: MR merge → status=completed ─────────────────────
    // 查刚创建的 MR iid（由 create_mr 事件 data 记录）
    const mrRows = await dbQuery<{ data: { mrIid: number } }>(
      `SELECT data FROM bug_fix_events WHERE report_id = $1 AND code = 'create_mr' AND status = 'success' LIMIT 1`,
      [reportId],
    )
    expect(mrRows.length).toBe(1)
    const mrIid = mrRows[0].data.mrIid
    expect(typeof mrIid).toBe('number')

    // webhook secret 默认空串（未配置 system_config.gitlab.webhookSecret）
    const mergeWebhook = await request.post('/webhook/gitlab', {
      headers: { 'x-gitlab-token': '' },
      data: {
        object_kind: 'merge_request',
        object_attributes: {
          iid: mrIid,
          title: 'fix',
          action: 'merge',
          source_branch: 'fix/issue-1-pas-api',
          target_branch: 'test',
        },
        project: { path_with_namespace: 'PAM/pas-api' },
      },
    })
    expect(mergeWebhook.ok()).toBe(true)

    const finalReport = await dbQuery<{ status: string }>(
      `SELECT status FROM bug_analysis_reports WHERE id = $1`,
      [reportId],
    )
    expect(finalReport[0].status).toBe('completed')

    const lifecycleEvents = await dbQuery<{ code: string; data: Record<string, unknown> }>(
      `SELECT code, data FROM bug_fix_events WHERE report_id = $1 AND code = 'lifecycle_sync'`,
      [reportId],
    )
    expect(lifecycleEvents.length).toBeGreaterThanOrEqual(1)
    expect(lifecycleEvents[0].data.mrAction).toBe('merge')
  })
})
