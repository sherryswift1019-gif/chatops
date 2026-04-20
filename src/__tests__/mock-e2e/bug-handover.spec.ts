/**
 * handover-mvp — 「转人工」按钮 e2e：覆盖用户点击按钮到状态流转的完整前端链路
 *
 * 场景：
 *   A. status=pipeline_success 时点「转人工」
 *      先走一轮 L1 happy-path 得到合法的 report + scope_identified 事件（owner=u-primary）
 *      然后 UI 点按钮 → Modal.confirm → 确认
 *      断言：
 *        - POST /admin/bug-reports/:id/handover 成功
 *        - message.success 文案"已转人工接手"
 *        - DB: report.status='pending_manual'
 *        - DB: bug_fix_events(code='handover', status='success'), data.reason='user_requested'
 *        - MockIMAdapter 给 u-primary 发了 DM（文案含 needs-manual / fix/issue- 关键字）
 *        - 前端状态 Tag 更新为 pending_manual（CSS class 含 ant-tag-warning）
 *
 *   B. status=aborted 时「转人工」按钮不可见、「重试」按钮可见
 *   C. status=pending_manual 时「转人工」和「重试」两个按钮都不可见
 *
 * Mock：复用 bug-retry.spec.ts / bug-l1-full-flow.spec.ts 相同的
 *   - seedClaudeMock（analyze_bug-filter / analyze_bug-detail / fix-<path> / review-<iid>）
 *   - 后端 /admin/_e2e/analyze-and-dispatch 触发完整链路
 *   - GET /admin/_e2e/messages?kind=direct&to=u-primary 查 owner DM
 *   - handover GitLab label PUT 命中 mock 的 /api/v4/*splat 兜底，返回 {ok:true}
 */
import { test, expect, type APIRequestContext } from '@playwright/test'
import { Pool } from 'pg'
import { resetPerTest, seedClaudeMock } from './helpers/per-test.js'

const GITLAB_MOCK = process.env.E2E_GITLAB_MOCK_URL ?? 'http://localhost:4001'

async function dbQuery<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  try {
    const { rows } = await pool.query(sql, params)
    return rows as T[]
  } finally {
    await pool.end()
  }
}

async function loginAsAdmin(request: APIRequestContext): Promise<void> {
  await dbQuery(`UPDATE admin_users SET must_change_password = FALSE WHERE username = 'admin'`)
  const r = await request.post('/admin/auth/login', {
    data: { username: 'admin', password: 'admin' },
  })
  expect(r.ok()).toBe(true)
}

interface RecordedMessage {
  kind: 'group' | 'direct' | 'card'
  to: string
  text?: string
  timestamp: number
}

async function fetchMessages(
  request: APIRequestContext,
  filter: { kind?: string; to?: string } = {},
): Promise<RecordedMessage[]> {
  const qs = new URLSearchParams()
  if (filter.kind) qs.set('kind', filter.kind)
  if (filter.to) qs.set('to', filter.to)
  const r = await request.get(`/admin/_e2e/messages?${qs.toString()}`)
  expect(r.ok()).toBe(true)
  return (await r.json()) as RecordedMessage[]
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

/**
 * 直接在 DB 里 seed 一个 minimal bug_analysis_report，用于场景 B/C
 * 不需要 scope_identified 等事件，因为这两个场景只是验证按钮可见性。
 */
async function seedMinimalReport(
  productLineId: number,
  issueId: number,
  status: 'aborted' | 'pending_manual',
): Promise<number> {
  const rows = await dbQuery<{ id: number }>(
    `INSERT INTO bug_analysis_reports
       (issue_id, issue_url, product_line_id, level, classification, confidence,
        confidence_score, root_cause_summary, solutions_json, affected_modules,
        analysis_steps, status)
     VALUES ($1, $2, $3, 'l1', 'bug', 'high', 0.9, $4, '[]'::jsonb,
             '[]'::jsonb, '[]'::jsonb, $5)
     RETURNING id`,
    [
      issueId,
      `http://mock-gitlab/PAM/pas-api/-/issues/${issueId}`,
      productLineId,
      `minimal seed for ${status}`,
      status,
    ],
  )
  return rows[0].id
}

test.describe('转人工按钮 → 用户主动 handover', () => {
  test.beforeEach(async ({ request }) => {
    await resetPerTest(request, GITLAB_MOCK)
  })

  test('场景 A：pipeline_success → 点转人工 → pending_manual + handover 事件 + owner DM', async ({
    request,
    page,
  }) => {
    await loginAsAdmin(request)

    const plRows = await dbQuery<{ id: number }>(
      `SELECT id FROM product_lines WHERE name = 'pam'`,
    )
    expect(plRows.length).toBe(1)
    const productLineId = plRows[0].id

    // ── 1. seed Claude mock：L1 happy-path（与 bug-l1-full-flow 相同） ─────
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
        summary: '配置缺失（handover 测试前置）',
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
    await seedClaudeMock(request, 'review-1', {
      label: 'ai-approved',
      summary: 'LGTM',
    })

    // ── 2. 触发完整 L1 链路 → 得到 status=pipeline_success 的报告 ─────────
    test.setTimeout(90_000)
    const dispatch = await request.post('/admin/_e2e/analyze-and-dispatch', {
      data: { productLineId, message: 'handover e2e 前置 L1 trigger' },
    })
    expect(dispatch.ok()).toBe(true)
    const dispatchBody = await dispatch.json()
    expect(dispatchBody.success).toBe(true)
    const { reportId } = dispatchBody.data as { reportId: number }
    expect(reportId).toBeGreaterThan(0)

    const reportRows = await dbQuery<{ status: string; issue_id: number }>(
      `SELECT status, issue_id FROM bug_analysis_reports WHERE id = $1`,
      [reportId],
    )
    expect(reportRows[0].status).toBe('pipeline_success')
    const issueId = reportRows[0].issue_id
    expect(issueId).toBeGreaterThan(0)

    // 记录触发 handover 之前 u-primary 已收到的 DM 数量（L1 fix_success 也会发一条）
    const msgsBefore = await fetchMessages(request, { kind: 'direct', to: 'u-primary' })
    const baselineCount = msgsBefore.length

    // ── 3. UI：打开 /bug-runs → 点「转人工」按钮 ─────────────────────────
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

    // 「转人工」3 个中文字符，AntD autoInsertSpace 仅在 2 字时插空格，保留原文
    // 注：AntD Collapse 把 extra（含转人工按钮）渲染在 header button 内部，导致 DOM 上
    // 出现 button > button 嵌套，getByRole('button', {name: '转人工'}) 会同时命中 header
    // 大按钮（accessible name 末尾含"转人工"）和 extra 小按钮。用 .last() 取真正的 extra 按钮。
    const handoverBtn = page.getByRole('button', { name: '转人工' }).last()
    await expect(handoverBtn).toBeVisible({ timeout: 10_000 })
    await handoverBtn.click()

    // Modal.confirm 弹窗
    const modal = page.locator('.ant-modal-confirm').filter({ hasText: '确认转人工接手？' })
    await expect(modal).toBeVisible({ timeout: 10_000 })

    // 点「确认转人工」（5 字，不插空格）
    const confirmBtn = modal.getByRole('button', { name: /确认转人工/ })
    await confirmBtn.click()

    // ── 4. 等 UI message.success ──────────────────────────────────────────
    const successMsg = page.locator('.ant-message-notice').filter({ hasText: /已转人工接手/ })
    await expect(successMsg).toBeVisible({ timeout: 15_000 })

    // ── 5. DB 断言：status=pending_manual ─────────────────────────────────
    const finalReport = await pollUntil(
      async () => {
        const rows = await dbQuery<{ status: string }>(
          `SELECT status FROM bug_analysis_reports WHERE id = $1`,
          [reportId],
        )
        return rows[0]?.status === 'pending_manual' ? rows[0] : null
      },
      { timeoutMs: 15_000, label: 'report.status → pending_manual' },
    )
    expect(finalReport.status).toBe('pending_manual')

    // ── 6. DB 断言：handover 事件 ────────────────────────────────────────
    const handoverEvents = await dbQuery<{
      code: string
      status: string
      data: Record<string, unknown>
    }>(
      `SELECT code, status, data FROM bug_fix_events WHERE report_id = $1 AND code = 'handover'`,
      [reportId],
    )
    expect(handoverEvents.length).toBeGreaterThanOrEqual(1)
    const handoverEvt = handoverEvents.find(e => e.status === 'success')
    expect(handoverEvt, '应有 code=handover, status=success 的事件').toBeTruthy()
    expect(handoverEvt!.data.reason).toBe('user_requested')
    // fixBranch 形如 fix/issue-<iid>
    expect(String(handoverEvt!.data.fixBranch)).toMatch(/^fix\/issue-\d+/)

    // ── 7. DM 断言：u-primary 收到 handover 文案 DM（基线之后至少多一条） ─
    const msgsAfter = await pollUntil(
      async () => {
        const msgs = await fetchMessages(request, { kind: 'direct', to: 'u-primary' })
        // handover DM 的特征文案：needs-manual + fix/issue- + "AI 放弃自动修复"
        const handoverDm = msgs.slice(baselineCount).find(m => {
          const text = m.text ?? ''
          return text.includes('needs-manual') && text.includes(`fix/issue-${issueId}`)
        })
        return handoverDm ?? null
      },
      { timeoutMs: 15_000, label: 'u-primary handover DM' },
    )
    expect(msgsAfter.text).toContain('AI 放弃自动修复')

    // notify 事件也应有一条 messageKind=handover 的成功记录
    const notifyEvents = await dbQuery<{ data: Record<string, unknown>; status: string }>(
      `SELECT data, status FROM bug_fix_events
       WHERE report_id = $1 AND code = 'notify' AND status = 'success'`,
      [reportId],
    )
    const handoverNotify = notifyEvents.find(e => e.data.messageKind === 'handover')
    expect(handoverNotify, '应有一条 notify 事件 messageKind=handover').toBeTruthy()
    expect(handoverNotify!.data.userId).toBe('u-primary')

    // ── 8. UI：前端状态 Tag 更新为 pending_manual ─────────────────────────
    // BugRunsPage 刷新时用 statusColors['pending_manual']='warning'，DOM class 含 ant-tag-warning
    const pendingManualTag = page
      .locator('.ant-tag')
      .filter({ hasText: /^pending_manual$/ })
      .first()
    await expect(pendingManualTag).toBeVisible({ timeout: 15_000 })
  })

  test('场景 B：status=aborted → 转人工按钮不可见，重试按钮可见', async ({ request, page }) => {
    await loginAsAdmin(request)

    const plRows = await dbQuery<{ id: number }>(
      `SELECT id FROM product_lines WHERE name = 'pam'`,
    )
    const productLineId = plRows[0].id

    // 直接 DB seed 一个 aborted 报告（issueId 任意，不要和 mock counter 冲突即可）
    await seedMinimalReport(productLineId, 8801, 'aborted')

    const loginResp = await page.request.post('/admin/auth/login', {
      data: { username: 'admin', password: 'admin' },
    })
    expect(loginResp.ok()).toBe(true)

    await page.goto('/bug-runs')
    const pageCard = page.locator('.ant-card').filter({ hasText: 'Bug 修复实例' }).first()
    await expect(pageCard).toBeVisible({ timeout: 10_000 })

    await pageCard.locator('.ant-select').first().click()
    await page.locator('.ant-select-item-option').filter({ hasText: 'PAM 特权访问管理' }).click()

    // 等 IssueCard 渲染出来
    await expect(page.locator('text=/Issue #8801/').first()).toBeVisible({ timeout: 10_000 })
    // 确认状态 tag
    await expect(
      page.locator('.ant-tag').filter({ hasText: /^aborted$/ }).first(),
    ).toBeVisible({ timeout: 10_000 })

    // 断言：重试按钮存在，转人工按钮不存在
    await expect(page.getByRole('button', { name: /^重\s?试$/ }).first()).toBeVisible({
      timeout: 10_000,
    })
    expect(await page.getByRole('button', { name: '转人工' }).count()).toBe(0)
  })

  test('场景 C：status=pending_manual → 两个按钮都不可见', async ({ request, page }) => {
    await loginAsAdmin(request)

    const plRows = await dbQuery<{ id: number }>(
      `SELECT id FROM product_lines WHERE name = 'pam'`,
    )
    const productLineId = plRows[0].id

    await seedMinimalReport(productLineId, 8802, 'pending_manual')

    const loginResp = await page.request.post('/admin/auth/login', {
      data: { username: 'admin', password: 'admin' },
    })
    expect(loginResp.ok()).toBe(true)

    await page.goto('/bug-runs')
    const pageCard = page.locator('.ant-card').filter({ hasText: 'Bug 修复实例' }).first()
    await expect(pageCard).toBeVisible({ timeout: 10_000 })

    await pageCard.locator('.ant-select').first().click()
    await page.locator('.ant-select-item-option').filter({ hasText: 'PAM 特权访问管理' }).click()

    await expect(page.locator('text=/Issue #8802/').first()).toBeVisible({ timeout: 10_000 })
    await expect(
      page.locator('.ant-tag').filter({ hasText: /^pending_manual$/ }).first(),
    ).toBeVisible({ timeout: 10_000 })

    // 两个按钮都不应存在
    expect(await page.getByRole('button', { name: '转人工' }).count()).toBe(0)
    expect(await page.getByRole('button', { name: /^重\s?试$/ }).count()).toBe(0)
  })
})
