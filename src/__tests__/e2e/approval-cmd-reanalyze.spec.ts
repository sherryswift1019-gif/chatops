/**
 * Task 18 Phase 3C — 场景 C3：群内 reanalyze 命令 → 触发重新分析
 *
 * 3A 没覆盖 reanalyze，这是真正的新场景。
 *
 * 流程：
 *   1. 触发 L3 analyze-and-dispatch（async=true） → 第 1 个 report + issueIid
 *   2. approve_l3 stage block
 *   3. 模拟消息 "@助手 reanalyze #<iid>" 经 _e2e/im/incoming
 *      → Step 0 去 @ → tryHandleCommand 匹配 → resolve('retry_analysis')
 *   4. pipeline onFailure=stop → failed → coordinator onComplete 分支：
 *      a) 标记第 1 份 report status='aborted'
 *      b) 补发 notify_bug
 *      c) 检测最后 approval.decision='retry_analysis' → 自动 triggerCapability('analyze_bug',
 *         reuseIssueId=报告 1 的 issueId) → 第 2 份 report 产生
 *         （analyzer 走 gitlabPostIssueNote 复用 issue，不 createIssue）
 *   5. 断言：
 *      a) 第 1 份 report status=aborted，approval(decision=retry_analysis)
 *      b) 第 2 份 report 存在，issueId 相同
 *      c) 第 2 份 report 的 create_issue 事件 isReused=true
 *      d) UI：BugRunsPage 的 IssueCard 显示 "2 轮" Tag，两个 RoundBody
 *         （旧 round aborted + 新 round draft/published，取决于 analyzer 终态）
 *
 * [简化-跳过 ClaudeRunner 全路径] 同 C1/C2。
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

test.describe('群内 reanalyze 命令 → 触发重新分析（真实 IM 入口简化路径）', () => {
  test.beforeEach(async ({ request }) => {
    await resetPerTest(request, GITLAB_MOCK)
  })

  test('analyze → L3 block → IM incoming "reanalyze #X" → 旧 round aborted + 新 round 复用同 issue', async ({
    request,
    page,
  }) => {
    await loginAsAdmin(request)

    const plRows = await dbQuery<{ id: number }>(
      `SELECT id FROM product_lines WHERE name = 'pam'`,
    )
    const productLineId = plRows[0].id

    // ── 1. Claude mock：第 1 轮 + 第 2 轮各需要 filter+detail ──────────────
    // 第 1 轮
    await seedClaudeMock(request, 'analyze_bug-filter', {
      involvedProjects: [
        { projectPath: 'PAM/pas-api', isPrimary: true, sourceBranch: 'test' },
      ],
      primaryProjectPath: 'PAM/pas-api',
    })
    await seedClaudeMock(request, 'analyze_bug-detail', {
      classification: 'bug',
      level: 'l3',
      confidence: 'medium',
      confidenceScore: 0.6,
      rootCause: { type: 'logic', summary: '第 1 轮分析（需要重新分析）', file: 'A.java', lineRange: [1, 10] },
      solutions: [{ id: 'a', summary: '改业务', recommended: true, risk: 'medium', effort: 'medium' }],
      affectedModules: ['auth'],
      analysisSteps: ['读代码'],
      markdown: '# L3 第 1 轮分析',
    })
    // 第 2 轮（reanalyze 触发后再跑一次 filter+detail）
    await seedClaudeMock(request, 'analyze_bug-filter', {
      involvedProjects: [
        { projectPath: 'PAM/pas-api', isPrimary: true, sourceBranch: 'test' },
      ],
      primaryProjectPath: 'PAM/pas-api',
    })
    await seedClaudeMock(request, 'analyze_bug-detail', {
      classification: 'bug',
      level: 'l3',
      confidence: 'high',
      confidenceScore: 0.9,
      rootCause: { type: 'logic', summary: '第 2 轮分析（更准确）', file: 'A.java', lineRange: [1, 10] },
      solutions: [{ id: 'a', summary: '换方案', recommended: true, risk: 'low', effort: 'low' }],
      affectedModules: ['auth'],
      analysisSteps: ['读代码', '查日志'],
      markdown: '# L3 第 2 轮分析（reanalyze 后）',
    })

    // ── 2. 异步触发第 1 轮 ────────────────────────────────────────────────
    test.setTimeout(60_000)
    const dispatch = await request.post('/admin/_e2e/analyze-and-dispatch', {
      data: {
        productLineId,
        message: 'L3 业务 Bug（需要 reanalyze）',
        async: true,
      },
    })
    expect(dispatch.ok()).toBe(true)
    const { reportId: firstReportId, classification, level } = (await dispatch.json()).data as {
      reportId: number
      classification: string
      level: string
    }
    expect(classification).toBe('bug')
    expect(level).toBe('l3')

    // ── 3. 等审批 DM ───────────────────────────────────────────────────────
    await pollUntil(
      async () => {
        const r = await request.get('/admin/_e2e/messages?kind=direct&to=u-primary')
        if (!r.ok()) return null
        const msgs = (await r.json()) as Array<{ text?: string }>
        return msgs.find(m => (m.text ?? '').includes('L3')) ?? null
      },
      { timeoutMs: 15_000, label: '主仓库 owner 收到审批 DM' },
    )

    const issueRows = await pollUntil(
      async () => {
        const rows = await dbQuery<{ data: { issueIid: number } }>(
          `SELECT data FROM bug_fix_events WHERE report_id = $1 AND code = 'create_issue' LIMIT 1`,
          [firstReportId],
        )
        return rows.length > 0 ? rows : null
      },
      { timeoutMs: 10_000, label: 'create_issue 事件出现' },
    )
    const issueIid = issueRows[0].data.issueIid

    // ── 4. 模拟消息 "@助手 reanalyze #<iid>" ───────────────────────────────
    const incomingText = `@助手 reanalyze #${issueIid}`
    const incomingResp = await request.post('/admin/_e2e/im/incoming', {
      data: {
        text: incomingText,
        groupId: 'g-test',
        userId: 'u-primary',
        userName: '主负责人',
      },
    })
    expect(incomingResp.ok()).toBe(true)
    const incomingBody = await incomingResp.json()
    expect(incomingBody.cleanedText).toBe(`reanalyze #${issueIid}`)
    expect(incomingBody.handled).toBe(true)

    // ── 5. 等第 1 份 report aborted ────────────────────────────────────────
    await pollUntil(
      async () => {
        const rows = await dbQuery<{ status: string }>(
          `SELECT status FROM bug_analysis_reports WHERE id = $1`,
          [firstReportId],
        )
        return rows[0]?.status === 'aborted' ? rows[0] : null
      },
      { timeoutMs: 15_000, label: '第 1 份 report status = aborted' },
    )

    // ── 6. 等第 2 份 report 被创建（retry_analysis 触发的 reanalyze） ──────
    const newReport = await pollUntil(
      async () => {
        const rows = await dbQuery<{ id: number; issue_id: number }>(
          `SELECT id, issue_id FROM bug_analysis_reports
           WHERE product_line_id = $1 AND id <> $2
           ORDER BY id DESC LIMIT 1`,
          [productLineId, firstReportId],
        )
        return rows.length > 0 ? rows[0] : null
      },
      { timeoutMs: 15_000, label: '第 2 份 report 被创建' },
    )
    // 第 2 份 report issueId 与第 1 份相同（复用 GitLab Issue）
    expect(newReport.issue_id).toBe(issueIid)

    // ── 7. 断言第 1 份 report 的 approval decision=retry_analysis ──────────
    const firstApprovalRows = await dbQuery<{ data: Record<string, unknown> }>(
      `SELECT data FROM bug_fix_events
       WHERE report_id = $1 AND code = 'approval' LIMIT 1`,
      [firstReportId],
    )
    expect(firstApprovalRows.length).toBe(1)
    expect(firstApprovalRows[0].data.decision).toBe('retry_analysis')

    // ── 8. 断言第 2 份 report 的 create_issue 事件 isReused=true ───────────
    const newCreateIssueRows = await pollUntil(
      async () => {
        const rows = await dbQuery<{ data: Record<string, unknown> }>(
          `SELECT data FROM bug_fix_events
           WHERE report_id = $1 AND code = 'create_issue' LIMIT 1`,
          [newReport.id],
        )
        return rows.length > 0 ? rows : null
      },
      { timeoutMs: 10_000, label: '第 2 份 report 的 create_issue 事件' },
    )
    expect(newCreateIssueRows[0].data.isReused).toBe(true)
    expect(newCreateIssueRows[0].data.issueIid).toBe(issueIid)

    // ── 9. UI 断言：BugRunsPage 显示 "2 轮" 与两个 Round ──────────────────
    const loginResp = await page.request.post('/admin/auth/login', {
      data: { username: 'admin', password: 'admin' },
    })
    expect(loginResp.ok()).toBe(true)

    await page.goto('/bug-runs')
    const pageCard = page.locator('.ant-card').filter({ hasText: 'Bug 修复实例' }).first()
    await expect(pageCard).toBeVisible({ timeout: 10_000 })

    await pageCard.locator('.ant-select').click()
    await page.locator('.ant-select-item-option').filter({ hasText: 'PAM 特权访问管理' }).click()

    // IssueCard 可见（同一 issueIid，两轮 report 合并到一张卡）
    await expect(page.locator(`text=/Issue #${issueIid}/`).first()).toBeVisible({ timeout: 10_000 })
    // 2 轮 Tag
    await expect(
      page.locator('.ant-tag').filter({ hasText: /^2 轮$/ }).first(),
    ).toBeVisible({ timeout: 10_000 })
    // 两个 Collapse 面板（RoundHeader 包含"第 1 轮"、"第 2 轮"）
    await expect(page.locator('text=/第 1 轮/').first()).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('text=/第 2 轮/').first()).toBeVisible({ timeout: 10_000 })
    // 旧 round 应该是 aborted 状态标签
    await expect(
      page.locator('.ant-tag').filter({ hasText: /^aborted$/ }).first(),
    ).toBeVisible({ timeout: 10_000 })
  })
})
