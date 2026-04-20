/**
 * Task 18 Phase 3A Wave 2 — 场景 7：重试按钮 → 新 pipeline_run
 *
 * ⚠️ 2026-04-20 update（handover MVP T5 之后本 spec 的测试场景不可达，已 skip）：
 *   原 spec 的前置条件是"L1 fix 失败 → report.status=aborted → 用户点前端重试按钮"。
 *   T5 commit（6c8b25a / a78230a）后，L1/L2 fix 失败会走 checkAndTriggerHandover(
 *   fix_exhausted) → status=**pending_manual** 而非 aborted。
 *
 *   前端 BugRunsPage 的"重试"按钮显示条件是 `status === 'aborted'`（参考
 *   web/src/pages/BugRunsPage.tsx RetryButtonExtra）——因此 pending_manual 状态下
 *   **没有重试按钮可点**。原 spec 的 UI 路径在当前实现下不可复现。
 *
 *   产品语义角度，这是刻意的设计：pending_manual 表示 AI 放弃，等 owner 在 GitLab
 *   接手（fix 分支保留），前端不提供"重新让 AI 试"的入口（避免用户反复消耗 token）。
 *   aborted 只在审批拒绝/超时/create_mr 失败等非 fix 失败场景出现。
 *
 *   后续选项：
 *   1. 把本 spec 重写为"L3 审批 reject → aborted → 点重试"（参考 bug-l3-reject.spec）
 *   2. 把本 spec 重写为"create_mr 失败 → aborted → 点重试"（需要 mock create_mr 失败）
 *   3. 保留 skip，依赖 POST /admin/bug-reports/:id/retry 的单测覆盖
 *      （src/__tests__/unit/admin-bug-reports.test.ts 里已有 retry 端点 8 条单测）
 *
 *   当前决策（2026-04-20）：选项 3——单测覆盖足够，e2e 的前端按钮路径待 V2 重写。
 *
 * 原流程：
 *   1. 先触发一次 L1 修复失败（fix=testPassed=false）→ status=aborted
 *   2. 再 seed 一组 happy-path mock（第二轮 analyze 会用到；reuseIssue → 走
 *      gitlabPostIssueNote 不创建新 issue，但 filter/detail/fix/review 仍走 mock）
 *   3. 打开 /bug-runs，点击 aborted 轮次的"重试"按钮 → Ant Design Modal.confirm 出现
 *   4. 点击弹窗里的"确认重试"按钮 → BugRunsPage 调 POST /admin/bug-reports/:id/retry
 *      后端同步 await handleAnalysisComplete 跑完，返回 { newReportId, newRunId }
 *   5. UI 显示 "已启动新一轮：报告 #N / 执行 #M" 的 message.success 提示
 *   6. DB 断言：bug_analysis_reports 多一行，issueId 与原报告相同，status=pipeline_success
 *
 * 注：retry endpoint 会调 gitlabPostIssueNote 往原 issue 追加 comment；e2e 的 mock
 * GitLab server 默认对 /issues/:iid/notes 返回 { id: 1 }，不需要额外 seed。
 */
import { test, expect, type APIRequestContext } from '@playwright/test'
import { Pool } from 'pg'
import { resetPerTest, seedClaudeMock } from './helpers/per-test.js'

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

async function pollUntil<T>(
  fn: () => Promise<T | null>,
  opts: { timeoutMs: number; intervalMs?: number; label?: string },
): Promise<T> {
  const { timeoutMs, intervalMs = 200, label = 'condition' } = opts
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = await fn()
    if (v !== null && v !== undefined) return v
    await new Promise(res => setTimeout(res, intervalMs))
  }
  throw new Error(`[pollUntil] timeout waiting for ${label} after ${timeoutMs}ms`)
}

test.describe('重试按钮 → 新 pipeline_run', () => {
  test.beforeEach(async ({ request }) => {
    await resetPerTest(request, GITLAB_MOCK)
  })

  // eslint-disable-next-line playwright/no-skipped-test
  test.skip('L1 fail → 点击重试按钮 → 新 pipeline_success', async ({ request, page }) => {
    await loginAsAdmin(request)

    const plRows = await dbQuery<{ id: number }>(
      `SELECT id FROM product_lines WHERE name = 'pam'`,
    )
    expect(plRows.length).toBe(1)
    const productLineId = plRows[0].id

    // ── 1. 第一轮：L1 修复失败（mock 与 bug-l1-failure 相同） ─────────────
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
        summary: '配置缺失（第一轮）',
        file: 'app.properties',
        lineRange: [10, 10],
      },
      solutions: [
        { id: 'a', summary: '补配置', recommended: true, risk: 'low', effort: 'low' },
      ],
      affectedModules: ['config'],
      analysisSteps: ['检查配置'],
      markdown: '# L1 分析（第一轮失败）',
    })
    await seedClaudeMock(request, 'fix-PAM/pas-api', {
      branch: 'fix/issue-1-pas-api',
      testPassed: false,
      error: '编译错误',
      output: '测试未通过',
    })

    test.setTimeout(90_000)
    const dispatch = await request.post('/admin/_e2e/analyze-and-dispatch', {
      data: { productLineId, message: 'L1 失败后需重试' },
    })
    expect(dispatch.ok()).toBe(true)
    const dispatchBody = await dispatch.json()
    expect(dispatchBody.success).toBe(true)
    const { reportId: firstReportId } = dispatchBody.data as { reportId: number }

    // 第一轮 aborted
    const firstReport = await dbQuery<{ status: string; issue_id: number }>(
      `SELECT status, issue_id FROM bug_analysis_reports WHERE id = $1`,
      [firstReportId],
    )
    expect(firstReport[0].status).toBe('aborted')
    const originalIssueId = firstReport[0].issue_id
    expect(originalIssueId).toBeGreaterThan(0)

    // ── 2. 第二轮 mock（重试会再次走完整 analyze → L1 pipeline 流程） ─────
    // 注：retry endpoint 使用 reuseIssueId，不会创建新 Issue，但 analyzer 会走
    // filter + detail → L1 pipeline fix → create_mr → ai_review → notify。
    // e2e-store.setMockResponse 按 key 追加队列，每次调用 shift 出队，所以重新 seed
    // 即可让第二轮走全新 mock 响应。
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
      confidenceScore: 0.95,
      rootCause: {
        type: 'config',
        summary: '配置已修正（第二轮）',
        file: 'app.properties',
        lineRange: [10, 10],
      },
      solutions: [
        { id: 'a', summary: '补配置', recommended: true, risk: 'low', effort: 'low' },
      ],
      affectedModules: ['config'],
      analysisSteps: ['检查配置'],
      markdown: '# L1 分析（第二轮成功）',
    })
    await seedClaudeMock(request, 'fix-PAM/pas-api', {
      branch: 'fix/issue-1-pas-api-retry',
      testPassed: true,
      output: '重试后所有测试通过',
    })
    // 第二轮 create_mr iid=1（mrCounter 从 0 起自增，第一次失败没走到 create_mr）
    await seedClaudeMock(request, 'review-1', { label: 'ai-approved', summary: 'LGTM retry' })

    // ── 3. 打开 /bug-runs，点击重试按钮 ────────────────────────────────────
    const loginResp = await page.request.post('/admin/auth/login', {
      data: { username: 'admin', password: 'admin' },
    })
    expect(loginResp.ok()).toBe(true)

    await page.goto('/bug-runs')
    const pageCard = page.locator('.ant-card').filter({ hasText: 'Bug 修复实例' }).first()
    await expect(pageCard).toBeVisible({ timeout: 10_000 })

    await pageCard.locator('.ant-select').first().click()
    await page.locator('.ant-select-item-option').filter({ hasText: 'PAM 特权访问管理' }).click()

    const issueCardTitle = page.locator('text=/Issue #\\d+/').first()
    await expect(issueCardTitle).toBeVisible({ timeout: 10_000 })

    // 点击"重试"按钮（RetryButtonExtra，只有 aborted 轮会渲染，位于 Collapse 每轮的 extra 区）
    // 注：AntD 5 默认 autoInsertSpace=true，会在两个中文字符间插入空格，accessible name 是 "重 试"
    const retryBtn = page.getByRole('button', { name: /^重\s?试$/ }).first()
    await expect(retryBtn).toBeVisible({ timeout: 10_000 })
    await retryBtn.click()

    // Ant Design Modal.confirm 弹窗出现
    const modal = page.locator('.ant-modal-confirm').filter({ hasText: '确认重新开始处理吗？' })
    await expect(modal).toBeVisible({ timeout: 10_000 })

    // 点击"确认重试"（AntD 多于 2 字则不插空格）
    const confirmBtn = modal.getByRole('button', { name: /确认重试/ })
    await confirmBtn.click()

    // ── 4. 等 UI 成功提示 ─────────────────────────────────────────────────
    // message.success: "已启动新一轮：报告 #<N>"
    const successMsg = page.locator('.ant-message-notice').filter({ hasText: /已启动新一轮/ })
    await expect(successMsg).toBeVisible({ timeout: 20_000 })

    // ── 5. DB 断言：新 report 存在 + issueId 复用 + status=pipeline_success ─
    const newReportRow = await pollUntil(
      async () => {
        const rows = await dbQuery<{
          id: number
          issue_id: number
          status: string
          pipeline_run_id: number | null
        }>(
          `SELECT id, issue_id, status, pipeline_run_id FROM bug_analysis_reports
           WHERE id <> $1 AND issue_id = $2 ORDER BY id DESC LIMIT 1`,
          [firstReportId, originalIssueId],
        )
        return rows.length > 0 ? rows[0] : null
      },
      { timeoutMs: 20_000, label: '重试产生新 report' },
    )
    expect(newReportRow.id).not.toBe(firstReportId)
    expect(newReportRow.issue_id).toBe(originalIssueId)
    expect(newReportRow.status).toBe('pipeline_success')
    expect(newReportRow.pipeline_run_id).toBeGreaterThan(0)

    // 新 create_issue 事件标记为 isReused=true
    const newCreateIssue = await dbQuery<{ data: Record<string, unknown> }>(
      `SELECT data FROM bug_fix_events WHERE report_id = $1 AND code = 'create_issue' LIMIT 1`,
      [newReportRow.id],
    )
    expect(newCreateIssue.length).toBe(1)
    expect(newCreateIssue[0].data.isReused).toBe(true)
  })
})
