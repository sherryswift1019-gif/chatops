/**
 * Task 18 Phase 3A — 场景 3：L3 审批通过 → 继续修复
 *
 * 流程：
 *   1. 异步触发 analyze-and-dispatch（async=true），analyze 返回 level=l3
 *   2. L3 pipeline 首个 stage approve_l3 调 PipelineApprovalManager.requestApproval
 *      → 发审批 DM 给主仓库 owner（u-primary）+ 从仓库 owner（u-secondary）发 FYI
 *   3. poll bug_fix_events 等待主 owner 收到审批 DM
 *   4. 调 POST /admin/_e2e/approve { issueIid, decision: 'approve' }
 *      → requestApproval resolve('approved')
 *   5. L3 pipeline 继续：fix_bug_l3 → create_mr → ai_review → notify_bug
 *   6. 等待 pipeline 终态 → status=pipeline_success
 *   7. 断言 bug_fix_events 含 approval(success) + 完整链路 + UI 可见
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

test.describe('L3 审批通过 → 继续修复', () => {
  test.beforeEach(async ({ request }) => {
    await resetPerTest(request, GITLAB_MOCK)
  })

  test('analyze → L3 approve_l3 block → approve 命令 → 继续全链路 → pipeline_success', async ({
    request,
    page,
  }) => {
    await loginAsAdmin(request)

    const plRows = await dbQuery<{ id: number }>(
      `SELECT id FROM product_lines WHERE name = 'pam'`,
    )
    expect(plRows.length).toBe(1)
    const productLineId = plRows[0].id

    // ── 1. 塞 claude mock 响应 ─────────────────────────────────────────────
    // 涉及 2 个 project（主仓库 PAM/pas-api + 从仓库 PAM/pas-web）以覆盖 L3 主从 owner
    await seedClaudeMock(request, 'analyze_bug-filter', {
      involvedProjects: [
        { projectPath: 'PAM/pas-api', isPrimary: true, sourceBranch: 'test' },
        { projectPath: 'PAM/pas-web', isPrimary: false, sourceBranch: 'test' },
      ],
      primaryProjectPath: 'PAM/pas-api',
    })
    await seedClaudeMock(request, 'analyze_bug-detail', {
      classification: 'bug',
      level: 'l3',
      confidence: 'medium',
      confidenceScore: 0.75,
      rootCause: {
        type: 'logic',
        summary: '跨服务校验逻辑错误',
        file: 'AuthService.java',
        lineRange: [88, 110],
      },
      solutions: [
        { id: 'a', summary: '改业务逻辑', recommended: true, risk: 'medium', effort: 'medium' },
      ],
      affectedModules: ['auth'],
      analysisSteps: ['读代码', '校对业务规则'],
      markdown: '# L3 分析\n业务逻辑错',
    })
    // detail 阶段按 project 逐个调用 → 2 个 project 需要 seed 2 次
    await seedClaudeMock(request, 'analyze_bug-detail', {
      classification: 'bug',
      level: 'l3',
      confidence: 'medium',
      confidenceScore: 0.75,
      rootCause: {
        type: 'logic',
        summary: '前端 UI 同步字段问题',
        file: 'AuthForm.tsx',
        lineRange: [30, 50],
      },
      solutions: [
        { id: 'a', summary: '同步前端字段', recommended: true, risk: 'medium', effort: 'low' },
      ],
      affectedModules: ['auth-ui'],
      analysisSteps: ['读前端代码'],
      markdown: '# L3 分析（web）\n前端配合',
    })
    // 两个 project 分别 fix
    await seedClaudeMock(request, 'fix-PAM/pas-api', {
      branch: 'fix/issue-1-pas-api',
      testPassed: true,
      output: '所有测试通过',
    })
    await seedClaudeMock(request, 'fix-PAM/pas-web', {
      branch: 'fix/issue-1-pas-web',
      testPassed: true,
      output: '所有测试通过',
    })
    // MR iid：两个 project 各自创建 MR，mock GitLab 自增 → 1, 2
    await seedClaudeMock(request, 'review-1', { label: 'ai-approved', summary: 'LGTM' })
    await seedClaudeMock(request, 'review-2', { label: 'ai-approved', summary: 'LGTM' })

    // ── 2. 异步触发链路（async=true 让 pipeline 在审批处 block） ──────────
    test.setTimeout(60_000)
    const dispatch = await request.post('/admin/_e2e/analyze-and-dispatch', {
      data: {
        productLineId,
        message: 'L3 跨服务业务逻辑 Bug',
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

    // ── 3. 等待审批 DM 被发送（根据 MockIMAdapter 记录） ───────────────────
    // PipelineApprovalManager.requestApproval 先发 DM 再 await，所以只要收到 DM
    // 就说明 pending 注册好了，可以安全调 approve。
    await pollUntil(
      async () => {
        const r = await request.get('/admin/_e2e/messages?kind=direct&to=u-primary')
        if (!r.ok()) return null
        const msgs = (await r.json()) as Array<{ text?: string; to: string }>
        return msgs.find(m => (m.text ?? '').includes('L3')) ?? null
      },
      { timeoutMs: 15_000, label: '主仓库 owner 收到审批 DM' },
    )

    // 查 issueId（create_issue 事件）
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
    expect(typeof issueIid).toBe('number')

    // 从仓库 owner 也应收到 FYI（approve_l3 handler 里额外发）
    const fyiResp = await request.get('/admin/_e2e/messages?kind=direct&to=u-secondary')
    const fyiMsgs = (await fyiResp.json()) as Array<{ text?: string }>
    expect(fyiMsgs.some(m => (m.text ?? '').includes('知情'))).toBe(true)

    // ── 4. 发送 approve 命令 ───────────────────────────────────────────────
    const approveResp = await request.post('/admin/_e2e/approve', {
      data: { issueIid, decision: 'approve' },
    })
    expect(approveResp.ok()).toBe(true)
    const approveBody = await approveResp.json()
    expect(approveBody.handled).toBe(true)

    // ── 5. 等待 pipeline 终态 ──────────────────────────────────────────────
    await pollUntil(
      async () => {
        const rows = await dbQuery<{ status: string }>(
          `SELECT status FROM bug_analysis_reports WHERE id = $1`,
          [reportId],
        )
        return rows[0]?.status === 'pipeline_success' ? rows[0] : null
      },
      { timeoutMs: 30_000, label: 'report status = pipeline_success' },
    )

    // ── 6. DB 断言：事件齐全 ──────────────────────────────────────────────
    const events = await dbQuery<{ code: string; status: string }>(
      `SELECT code, status FROM bug_fix_events WHERE report_id = $1 ORDER BY id`,
      [reportId],
    )
    const codes = events.map(e => e.code)
    for (const expected of [
      'analysis',
      'scope_identified',
      'create_issue',
      'approval',
      'fix_attempt',
      'create_mr',
      'ai_review',
      'notify',
    ]) {
      expect(codes, `events 缺少 ${expected}`).toContain(expected)
    }
    // approval 应是 success（decision=approved）
    const approvalEv = events.find(e => e.code === 'approval')
    expect(approvalEv?.status).toBe('success')

    // ── 7. UI 断言：BugRunsPage 可见审批事件 + 成功状态 ─────────────────────
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

    // L3 标签
    await expect(page.locator('.ant-tag').filter({ hasText: /^L3$/ }).first()).toBeVisible({
      timeout: 10_000,
    })
    // pipeline_success 标签
    await expect(
      page.locator('.ant-tag').filter({ hasText: /^pipeline_success$/ }).first(),
    ).toBeVisible({ timeout: 10_000 })

    // 审批事件文本：EventContent 'approval' → "审批: approved"
    await expect(
      page.locator('.ant-timeline').getByText('审批: approved'),
    ).toBeVisible({ timeout: 10_000 })
    // AI Review 事件
    await expect(
      page.locator('.ant-timeline').getByText('AI Review: ai-approved').first(),
    ).toBeVisible({ timeout: 10_000 })

    // ── 8. DM 断言：成功通知 ───────────────────────────────────────────────
    const successMsgs = await request.get('/admin/_e2e/messages?kind=direct&to=u-primary')
    const primary = (await successMsgs.json()) as Array<{ text?: string }>
    // u-primary 先收审批 DM，再收修复成功 DM（fix_success 场景 shouldNotifyOwners=true）
    expect(primary.some(m => (m.text ?? '').includes('已自动修复'))).toBe(true)
  })
})
