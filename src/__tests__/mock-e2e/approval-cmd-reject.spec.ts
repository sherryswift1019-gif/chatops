/**
 * Task 18 Phase 3C — 场景 C2：群内 reject 命令（真实 IM 入口简化路径）
 *
 * 与 3A 的 bug-l3-reject.spec.ts 不同：走 _e2e/im/incoming（复现 Step 0 去 @ +
 * tryHandleCommand），验证从真实消息文本到审批拒绝的完整链路。
 *
 * [简化-跳过 ClaudeRunner 全路径] 同 C1：endpoint 跳过 Porygon intent 检测，
 * 只复现 Step 0 审批拦截逻辑。
 *
 * 流程：
 *   1. 异步触发 analyze-and-dispatch（async=true） → level=l3
 *   2. approve_l3 stage block
 *   3. 模拟消息 "@助手 reject #<iid>" → Step 0 去 @ → tryHandleCommand resolve('rejected')
 *   4. pipeline onFailure=stop → aborted
 *   5. 断言：events 含 approval(failed) 不含 fix_attempt/create_mr/ai_review
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

test.describe('群内 reject 命令 → pipeline aborted（真实 IM 入口简化路径）', () => {
  test.beforeEach(async ({ request }) => {
    await resetPerTest(request, GITLAB_MOCK)
  })

  test('analyze → L3 block → IM incoming "@助手 reject #X" → aborted', async ({
    request,
    page,
  }) => {
    await loginAsAdmin(request)

    const plRows = await dbQuery<{ id: number }>(
      `SELECT id FROM product_lines WHERE name = 'pam'`,
    )
    const productLineId = plRows[0].id

    // ── 1. Claude mock：仅需 filter + detail（被拒后不 fix） ────────────────
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
      confidenceScore: 0.65,
      rootCause: { type: 'logic', summary: 'IM 入口 reject 验证', file: 'Y.java', lineRange: [1, 10] },
      solutions: [{ id: 'a', summary: '改业务', recommended: true, risk: 'medium', effort: 'medium' }],
      affectedModules: ['auth'],
      analysisSteps: ['读代码'],
      markdown: '# L3 分析（IM 入口 reject）',
    })

    // ── 2. 异步触发 ────────────────────────────────────────────────────────
    test.setTimeout(60_000)
    const dispatch = await request.post('/admin/_e2e/analyze-and-dispatch', {
      data: {
        productLineId,
        message: 'L3 业务逻辑 Bug（IM 入口 reject）',
        async: true,
      },
    })
    expect(dispatch.ok()).toBe(true)
    const { reportId, classification, level } = (await dispatch.json()).data as {
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
          [reportId],
        )
        return rows.length > 0 ? rows : null
      },
      { timeoutMs: 10_000, label: 'create_issue 事件出现' },
    )
    const issueIid = issueRows[0].data.issueIid

    // ── 4. 模拟消息 "@助手 reject #<iid>" 经 _e2e/im/incoming ──────────────
    const incomingText = `@助手 reject #${issueIid}`
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
    expect(incomingBody.cleanedText).toBe(`reject #${issueIid}`)
    expect(incomingBody.handled).toBe(true)

    // ── 5. 等 aborted ──────────────────────────────────────────────────────
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

    // ── 6. DB 断言 ────────────────────────────────────────────────────────
    const events = await dbQuery<{ code: string; status: string }>(
      `SELECT code, status FROM bug_fix_events WHERE report_id = $1 ORDER BY id`,
      [reportId],
    )
    const codes = events.map(e => e.code)
    for (const expected of ['analysis', 'scope_identified', 'create_issue', 'approval']) {
      expect(codes, `events 缺少 ${expected}`).toContain(expected)
    }
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

    await page.goto(`/bug-runs?productLine=${productLineId}`)
    const pageCard = page.locator('.ant-card').filter({ hasText: 'Bug 修复实例' }).first()
    await expect(pageCard).toBeVisible({ timeout: 10_000 })

    const firstRow = pageCard.locator('.ant-table-tbody tr.ant-table-row').first()
    await expect(firstRow).toBeVisible({ timeout: 10_000 })

    // 中文「已终止」tag
    await expect(
      pageCard.locator('.ant-table-tbody .ant-tag').filter({ hasText: /已终止/ }).first(),
    ).toBeVisible({ timeout: 10_000 })

    // Drawer Timeline 含 codeLabel="审批" 且不含「创建 MR」
    await firstRow.getByRole('button', { name: '详情' }).click()
    const drawer = page.locator('.ant-drawer-content')
    await expect(drawer).toBeVisible({ timeout: 10_000 })

    const fullTimeline = drawer.locator('.ant-timeline').last()
    await expect(
      fullTimeline.locator('.ant-tag').filter({ hasText: /^审批$/ }).first(),
    ).toBeVisible({ timeout: 10_000 })

    await expect(
      fullTimeline.locator('.ant-tag').filter({ hasText: /^创建 MR$/ }),
    ).toHaveCount(0)
  })
})
