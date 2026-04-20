/**
 * Task 18 Phase 3C — 场景 C1：群内 approve 命令（真实 IM 入口简化路径）
 *
 * 与 3A 的 bug-l3-approve.spec.ts 不同：
 *   - 3A 通过 POST /admin/_e2e/approve { issueIid, decision } 直接封装 tryHandleCommand
 *   - 3C 通过 POST /admin/_e2e/im/incoming { text: "@机器人 approve #<iid>" } 复现
 *     ClaudeRunner.run() Step 0 的 cleanedForApproval 逻辑：先去 @机器人 mention、
 *     再调 tryHandleCommand。这一段是钉钉群消息 -> 审批被接住的核心路径。
 *
 * [简化-跳过 ClaudeRunner 全路径] 说明：
 *   真实链路还包含 SessionManager 入队 + intent 检测（Porygon）等环节。e2e 下
 *   intent 检测会 spawn claude CLI，不可用。因此 _e2e/im/incoming 端点只复现
 *   Step 0（审批命令拦截）的逻辑，跳过 intent 检测。这是 3C 相对 3A 的增值部分：
 *   验证从「真实消息文本」到 tryHandleCommand 的解析（去 @ + 正则）是通顺的。
 *
 * 流程：
 *   1. 异步触发 analyze-and-dispatch（async=true），analyze 返回 level=l3
 *   2. L3 pipeline approve_l3 stage 发审批 DM → 等 decision
 *   3. 模拟群消息 "@钉钉助手 approve #<issueIid>" 经 _e2e/im/incoming
 *      → Step 0 去除 @ mention → tryHandleCommand('approve #iid') → resolve('approved')
 *   4. pipeline 继续 → fix → MR → review → notify → pipeline_success
 *   5. 断言：events 齐全 + UI 显示审批通过 + 成功状态
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

test.describe('群内 approve 命令 → pipeline 继续（真实 IM 入口简化路径）', () => {
  test.beforeEach(async ({ request }) => {
    await resetPerTest(request, GITLAB_MOCK)
  })

  test('analyze → L3 block → IM incoming "@钉钉助手 approve #X" → pipeline_success', async ({
    request,
    page,
  }) => {
    await loginAsAdmin(request)

    const plRows = await dbQuery<{ id: number }>(
      `SELECT id FROM product_lines WHERE name = 'pam'`,
    )
    const productLineId = plRows[0].id

    // ── 1. Claude mock: L3 需要 filter + detail + fix + review ─────────────
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
      rootCause: { type: 'logic', summary: 'IM 入口审批链路验证', file: 'X.java', lineRange: [1, 10] },
      solutions: [{ id: 'a', summary: '改业务', recommended: true, risk: 'medium', effort: 'medium' }],
      affectedModules: ['auth'],
      analysisSteps: ['读代码'],
      markdown: '# L3 分析（IM 入口 approve）',
    })
    await seedClaudeMock(request, 'fix-PAM/pas-api', {
      branch: 'fix/issue-imapprove-pas-api',
      testPassed: true,
      output: '所有测试通过',
    })
    await seedClaudeMock(request, 'review-1', { label: 'ai-approved', summary: 'LGTM' })

    // ── 2. 异步触发 pipeline ───────────────────────────────────────────────
    test.setTimeout(60_000)
    const dispatch = await request.post('/admin/_e2e/analyze-and-dispatch', {
      data: {
        productLineId,
        message: 'L3 业务逻辑 Bug（IM 入口 approve）',
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

    // ── 3. 等待审批 DM 抵达（pending 已注册） ──────────────────────────────
    await pollUntil(
      async () => {
        const r = await request.get('/admin/_e2e/messages?kind=direct&to=u-primary')
        if (!r.ok()) return null
        const msgs = (await r.json()) as Array<{ text?: string }>
        return msgs.find(m => (m.text ?? '').includes('L3')) ?? null
      },
      { timeoutMs: 15_000, label: '主仓库 owner 收到审批 DM' },
    )

    // 取 issueIid
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

    // ── 4. 模拟群内消息 "@钉钉助手 approve #<iid>" 经 /admin/_e2e/im/incoming ──
    //    Step 0 会先把 "@钉钉助手"（中文 mention）去掉，再 tryHandleCommand
    const incomingText = `@钉钉助手 approve #${issueIid}`
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
    // 核心断言：@机器人 去除后文本是 "approve #<iid>"，tryHandleCommand 命中
    expect(incomingBody.cleanedText).toBe(`approve #${issueIid}`)
    expect(incomingBody.handled).toBe(true)

    // ── 5. 等 pipeline 终态 ────────────────────────────────────────────────
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

    // ── 6. DB 断言：events 齐全 + approval=success ─────────────────────────
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
    const approvalEv = events.find(e => e.code === 'approval')
    expect(approvalEv?.status).toBe('success')

    // ── 7. UI 断言：BugRunsPage 显示 pipeline_success + 审批通过事件 ────────
    const loginResp = await page.request.post('/admin/auth/login', {
      data: { username: 'admin', password: 'admin' },
    })
    expect(loginResp.ok()).toBe(true)

    await page.goto(`/bug-runs?productLine=${productLineId}`)
    const pageCard = page.locator('.ant-card').filter({ hasText: 'Bug 修复实例' }).first()
    await expect(pageCard).toBeVisible({ timeout: 10_000 })

    const firstRow = pageCard.locator('.ant-table-tbody tr.ant-table-row').first()
    await expect(firstRow).toBeVisible({ timeout: 10_000 })

    // 中文「Pipeline 成功」tag
    await expect(
      pageCard.locator('.ant-table-tbody .ant-tag').filter({ hasText: /Pipeline 成功/ }).first(),
    ).toBeVisible({ timeout: 10_000 })

    // Drawer 内 Section 5 Timeline 含 codeLabel="审批"
    await firstRow.getByRole('button', { name: '详情' }).click()
    const drawer = page.locator('.ant-drawer-content')
    await expect(drawer).toBeVisible({ timeout: 10_000 })

    const fullTimeline = drawer.locator('.ant-timeline').last()
    await expect(
      fullTimeline.locator('.ant-tag').filter({ hasText: /^审批$/ }).first(),
    ).toBeVisible({ timeout: 10_000 })
  })
})
