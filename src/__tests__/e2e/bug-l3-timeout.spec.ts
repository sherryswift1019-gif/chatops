/**
 * Task 18 Phase 3A Wave 2 — 场景 5：L3 审批超时 → status=aborted
 *
 * 【降级说明】
 *   当前产品代码的 approve_l3 handler 写死 `mgr.requestApproval(timeoutMs=3_600_000)`
 *   （即 1 小时），pipeline stage 的 timeoutSeconds 不会传入 approval-manager。
 *   因此 e2e 无法在合理时间内走 "approval-manager 内部 timeout → decision=timeout
 *   → 写 approval(status=failed,data.decision=timeout)" 这条路径。
 *
 *   降级方案：改走 "pipeline stage-level timeout" 路径。把 L3 pipeline approve_l3
 *   stage 的 timeoutSeconds 改成 2 秒，stage executor 的 timeoutPromise 会在 2s 后
 *   abort capability 并抛 `capability 执行超时`，pipeline onFailure=stop → aborted，
 *   coordinator 补发 notify_bug 完成闭环。
 *
 *   注意：stage-abort 路径下 approve_l3 handler 本身还 block 在 requestApproval 里
 *   （它不监听 signal），要 1 小时后才返回 → 届时会写一条 approval(decision=timeout)
 *   事件，但测试此刻看不到，所以【降级-DB】只断言 status + 无后续事件。
 *
 * 流程：
 *   1. beforeEach 把 L3 pipeline approve_l3 stage timeoutSeconds 改成 2 秒
 *   2. 异步触发 analyze-and-dispatch → 发审批 DM → 等 2 秒 stage timeout
 *   3. pipeline status=aborted；不出现 fix_attempt / create_mr / ai_review
 *   4. afterEach 恢复 timeoutSeconds=3600
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

test.describe('L3 审批超时 → aborted', () => {
  test.beforeEach(async ({ request }) => {
    await resetPerTest(request, GITLAB_MOCK)
    // 缩短 L3-业务逻辑 approve_l3 stage 的 timeoutSeconds（第 0 个 stage）
    await dbQuery(`
      UPDATE test_pipelines
      SET stages = jsonb_set(stages, '{0,timeoutSeconds}', '2'::jsonb)
      WHERE name = 'L3-业务逻辑'
    `)
  })

  test.afterEach(async () => {
    // 恢复 approve_l3 stage timeoutSeconds，避免污染其他 spec
    await dbQuery(`
      UPDATE test_pipelines
      SET stages = jsonb_set(stages, '{0,timeoutSeconds}', '3600'::jsonb)
      WHERE name = 'L3-业务逻辑'
    `)
  })

  test('[降级-DB] analyze → L3 approve_l3 stage timeout → aborted（无后续 fix/mr/review）', async ({
    request,
    page,
  }) => {
    await loginAsAdmin(request)

    const plRows = await dbQuery<{ id: number }>(
      `SELECT id FROM product_lines WHERE name = 'pam'`,
    )
    expect(plRows.length).toBe(1)
    const productLineId = plRows[0].id

    // ── 1. 塞 claude mock：只需要 analyze（stage-timeout 路径不会进入 fix 阶段） ─
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
        summary: '业务校验漏判',
        file: 'Service.java',
        lineRange: [10, 20],
      },
      solutions: [
        { id: 'a', summary: '补业务校验', recommended: true, risk: 'medium', effort: 'medium' },
      ],
      affectedModules: ['auth'],
      analysisSteps: ['读代码'],
      markdown: '# L3 分析（审批会超时）',
    })

    // ── 2. 异步触发 ────────────────────────────────────────────────────────
    test.setTimeout(60_000)
    const dispatch = await request.post('/admin/_e2e/analyze-and-dispatch', {
      data: {
        productLineId,
        message: 'L3 业务 Bug（审批会超时）',
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

    // ── 3. 等审批 DM 发送（确认 pipeline 已进入 approve_l3 block） ────────
    await pollUntil(
      async () => {
        const r = await request.get('/admin/_e2e/messages?kind=direct&to=u-primary')
        if (!r.ok()) return null
        const msgs = (await r.json()) as Array<{ text?: string }>
        return msgs.find(m => (m.text ?? '').includes('L3')) ?? null
      },
      { timeoutMs: 15_000, label: '主仓库 owner 收到审批 DM' },
    )

    // ── 4. 等 stage-timeout 触发（2s + buffer），report 终态 aborted ──────
    await pollUntil(
      async () => {
        const rows = await dbQuery<{ status: string }>(
          `SELECT status FROM bug_analysis_reports WHERE id = $1`,
          [reportId],
        )
        return rows[0]?.status === 'aborted' ? rows[0] : null
      },
      { timeoutMs: 30_000, label: 'report status = aborted (stage timeout)' },
    )

    // ── 5. DB 断言：不走到 fix/create_mr/ai_review ────────────────────────
    const events = await dbQuery<{
      code: string
      status: string
      data: Record<string, unknown>
    }>(
      `SELECT code, status, data FROM bug_fix_events WHERE report_id = $1 ORDER BY id`,
      [reportId],
    )
    const codes = events.map(e => e.code)
    for (const expected of ['analysis', 'scope_identified', 'create_issue']) {
      expect(codes, `events 缺少 ${expected}`).toContain(expected)
    }
    // stage-timeout abort 后 approve_l3 handler 仍 block（3600s 后才写 approval
    // 事件），pipeline 执行器已转入 failed 分支。因此测试可观察到的事件里
    // 不应出现 fix/mr/review。
    expect(codes).not.toContain('fix_attempt')
    expect(codes).not.toContain('create_mr')
    expect(codes).not.toContain('ai_review')

    // ── 6. UI 断言：aborted 徽标 + L3 tag ─────────────────────────────────
    const loginResp = await page.request.post('/admin/auth/login', {
      data: { username: 'admin', password: 'admin' },
    })
    expect(loginResp.ok()).toBe(true)

    await page.goto('/bug-runs')
    const pageCard = page.locator('.ant-card').filter({ hasText: 'Bug 修复实例' }).first()
    await expect(pageCard).toBeVisible({ timeout: 10_000 })

    await pageCard.locator('.ant-select').click()
    await page.locator('.ant-select-item-option').filter({ hasText: 'PAM 特权访问管理' }).click()

    const issueCardTitle = page.locator('text=/Issue #\\d+/').first()
    await expect(issueCardTitle).toBeVisible({ timeout: 10_000 })

    await expect(page.locator('.ant-tag').filter({ hasText: /^L3$/ }).first()).toBeVisible({
      timeout: 10_000,
    })
    await expect(
      page.locator('.ant-tag').filter({ hasText: /^aborted$/ }).first(),
    ).toBeVisible({ timeout: 10_000 })

    // Timeline 里不应该出现 MR / AI Review 文案
    expect(await page.locator('.ant-timeline').getByText(/MR !\d+/).count()).toBe(0)
    expect(await page.locator('.ant-timeline').getByText(/AI Review:/).count()).toBe(0)
  })
})
