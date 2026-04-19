/**
 * Task 18 Phase 3A — 场景 4：L3 审批拒绝 → pipeline aborted
 *
 * 流程：
 *   1. 异步触发 analyze-and-dispatch（async=true），analyze 返回 level=l3
 *   2. L3 pipeline approve_l3 stage 发审批 DM → 等 decision
 *   3. 发送 reject 命令 → requestApproval resolve('rejected')
 *   4. approve_l3 capability 返回 success=false（decision='rejected'）
 *   5. pipeline onFailure=stop → aborted；coordinator onComplete(failed) 补发 notify_bug
 *      （approval_rejected 场景 shouldNotifyOwners=false，不发 DM）
 *   6. 断言：report status=aborted，events 含 approval(failed) 但 不含 fix_attempt/create_mr/ai_review
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

test.describe('L3 审批拒绝 → aborted', () => {
  test.beforeEach(async ({ request }) => {
    await resetPerTest(request, GITLAB_MOCK)
  })

  test('analyze → L3 approve_l3 block → reject 命令 → aborted，不执行后续 fix', async ({
    request,
    page,
  }) => {
    await loginAsAdmin(request)

    const plRows = await dbQuery<{ id: number }>(
      `SELECT id FROM product_lines WHERE name = 'pam'`,
    )
    expect(plRows.length).toBe(1)
    const productLineId = plRows[0].id

    // ── 1. 塞 claude mock：与场景 3 类似，但不需要 fix/review 的 mock ─────
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
      confidenceScore: 0.7,
      rootCause: {
        type: 'logic',
        summary: '业务校验不足',
        file: 'Service.java',
        lineRange: [10, 20],
      },
      solutions: [
        { id: 'a', summary: '改业务逻辑', recommended: true, risk: 'medium', effort: 'medium' },
      ],
      affectedModules: ['auth'],
      analysisSteps: ['读代码'],
      markdown: '# L3 分析',
    })

    // ── 2. 异步触发 ────────────────────────────────────────────────────────
    test.setTimeout(60_000)
    const dispatch = await request.post('/admin/_e2e/analyze-and-dispatch', {
      data: {
        productLineId,
        message: 'L3 业务逻辑 Bug（方案不行）',
        async: true,
      },
    })
    expect(dispatch.ok()).toBe(true)
    const dispatchBody = await dispatch.json()
    expect(dispatchBody.success).toBe(true)
    const { reportId, classification, level } = dispatchBody.data as {
      reportId: number
      classification: string
      level: string
    }
    expect(classification).toBe('bug')
    expect(level).toBe('l3')

    // ── 3. 等审批 DM 到达 ──────────────────────────────────────────────────
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
          [reportId],
        )
        return rows.length > 0 ? rows : null
      },
      { timeoutMs: 10_000, label: 'create_issue 事件出现' },
    )
    const issueIid = issueRows[0].data.issueIid

    // ── 4. 发 reject 命令 ──────────────────────────────────────────────────
    const rejectResp = await request.post('/admin/_e2e/approve', {
      data: { issueIid, decision: 'reject' },
    })
    expect(rejectResp.ok()).toBe(true)
    const rejectBody = await rejectResp.json()
    expect(rejectBody.handled).toBe(true)

    // ── 5. 等 report 终态 aborted ──────────────────────────────────────────
    await pollUntil(
      async () => {
        const rows = await dbQuery<{ status: string }>(
          `SELECT status FROM bug_analysis_reports WHERE id = $1`,
          [reportId],
        )
        return rows[0]?.status === 'aborted' ? rows[0] : null
      },
      { timeoutMs: 15_000, label: 'report status = aborted' },
    )

    // ── 6. DB 断言：events 含 approval(failed)，不含后续 fix/MR/review ─────
    const events = await dbQuery<{ code: string; status: string }>(
      `SELECT code, status FROM bug_fix_events WHERE report_id = $1 ORDER BY id`,
      [reportId],
    )
    const codes = events.map(e => e.code)
    for (const expected of ['analysis', 'scope_identified', 'create_issue', 'approval']) {
      expect(codes, `events 缺少 ${expected}`).toContain(expected)
    }
    // 审批被拒绝后，后续 stage 不执行
    expect(codes).not.toContain('fix_attempt')
    expect(codes).not.toContain('create_mr')
    expect(codes).not.toContain('ai_review')

    const approvalEv = events.find(e => e.code === 'approval')
    expect(approvalEv?.status).toBe('failed')

    // ── 7. UI 断言 ────────────────────────────────────────────────────────
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

    // aborted 标签
    await expect(
      page.locator('.ant-tag').filter({ hasText: /^aborted$/ }).first(),
    ).toBeVisible({ timeout: 10_000 })

    // 审批事件（rejected）
    await expect(
      page.locator('.ant-timeline').getByText('审批: rejected'),
    ).toBeVisible({ timeout: 10_000 })

    // UI 不应出现 MR / AI Review 文案
    expect(
      await page.locator('.ant-timeline').getByText(/MR !\d+/).count(),
    ).toBe(0)
    expect(
      await page.locator('.ant-timeline').getByText(/AI Review:/).count(),
    ).toBe(0)
  })
})
