/**
 * Task 18 Phase 3A Wave 2 — 场景 5：L3 审批超时 → status=aborted
 *
 * 走正面路径：approve_l3 capability 的 capabilityParams 里注入 approvalTimeoutMs=2000，
 * handler 透传给 PipelineApprovalManager.requestApproval，2 秒后内部 timeout 返回
 * decision=timeout → handler 写 approval(status=failed, data.decision='timeout') 事件
 * → capability 返回 success=false → pipeline onFailure=stop → aborted。
 *
 * 流程：
 *   1. beforeEach 在 L3 pipeline 的 approve_l3 stage capabilityParams 里注入
 *      approvalTimeoutMs = 2000
 *   2. 异步触发 analyze-and-dispatch → 发审批 DM → 2 秒后 approval-manager 超时
 *   3. pipeline status=aborted；bug_fix_events 里能查到
 *      approval(status=failed, data.decision='timeout')
 *   4. 不出现 fix_attempt / create_mr / ai_review
 *   5. afterEach 移除 approvalTimeoutMs，避免污染其他 spec
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
    // 给 L3-业务逻辑 pipeline 的第一个 stage（approve_l3）capabilityParams 里注入 approvalTimeoutMs=2000
    await dbQuery(`
      UPDATE test_pipelines
      SET stages = jsonb_set(
        stages,
        '{0,capabilityParams,approvalTimeoutMs}',
        '2000'::jsonb
      )
      WHERE name = 'L3-业务逻辑'
    `)
  })

  test.afterEach(async () => {
    // 恢复注入前的默认 approvalTimeoutMs（base.sql 里是 3600000），避免污染后续 spec。
    // C3 后 handler fail-fast：approvalTimeoutMs 缺失会直接 return invalid_timeout，
    // 所以不能用 `#-` 删 key，必须还原为默认值。
    await dbQuery(`
      UPDATE test_pipelines
      SET stages = jsonb_set(
        stages,
        '{0,capabilityParams,approvalTimeoutMs}',
        '3600000'::jsonb
      )
      WHERE name = 'L3-业务逻辑'
    `)
  })

  test('analyze → L3 approve_l3 内部超时 → aborted（approval 事件 decision=timeout）', async ({
    request,
    page,
  }) => {
    await loginAsAdmin(request)

    const plRows = await dbQuery<{ id: number }>(
      `SELECT id FROM product_lines WHERE name = 'pam'`,
    )
    expect(plRows.length).toBe(1)
    const productLineId = plRows[0].id

    // ── 1. 塞 claude mock：只需要 analyze（timeout 路径不会进入 fix 阶段） ─
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

    // ── 3. 等审批 DM 发送（确认 pipeline 已进入 approve_l3） ──────────────
    await pollUntil(
      async () => {
        const r = await request.get('/admin/_e2e/messages?kind=direct&to=u-primary')
        if (!r.ok()) return null
        const msgs = (await r.json()) as Array<{ text?: string }>
        return msgs.find(m => (m.text ?? '').includes('L3')) ?? null
      },
      { timeoutMs: 15_000, label: '主仓库 owner 收到审批 DM' },
    )

    // ── 4. 等 approval-manager 超时（2s + buffer），report 终态 aborted ───
    await pollUntil(
      async () => {
        const rows = await dbQuery<{ status: string }>(
          `SELECT status FROM bug_analysis_reports WHERE id = $1`,
          [reportId],
        )
        return rows[0]?.status === 'aborted' ? rows[0] : null
      },
      { timeoutMs: 30_000, label: 'report status = aborted (approval timeout)' },
    )

    // ── 5. DB 断言：approval 事件存在，decision=timeout，status=failed ────
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

    // 核心断言：approval 事件存在 + decision=timeout + status=failed
    const approvalEvents = events.filter(e => e.code === 'approval')
    expect(approvalEvents.length, 'approval 事件至少一条').toBeGreaterThanOrEqual(1)
    const timeoutApproval = approvalEvents.find(
      e => e.status === 'failed' && e.data?.decision === 'timeout',
    )
    expect(timeoutApproval, 'approval 事件应包含 decision=timeout, status=failed').toBeTruthy()

    // timeout 后不应走到 fix/mr/review
    expect(codes).not.toContain('fix_attempt')
    expect(codes).not.toContain('create_mr')
    expect(codes).not.toContain('ai_review')

    // ── 6. UI 断言：aborted 徽标 + L3 tag ─────────────────────────────────
    const loginResp = await page.request.post('/admin/auth/login', {
      data: { username: 'admin', password: 'admin' },
    })
    expect(loginResp.ok()).toBe(true)

    await page.goto(`/bug-runs?productLine=${productLineId}`)
    const pageCard = page.locator('.ant-card').filter({ hasText: 'Bug 修复实例' }).first()
    await expect(pageCard).toBeVisible({ timeout: 10_000 })

    const firstRow = pageCard.locator('.ant-table-tbody tr.ant-table-row').first()
    await expect(firstRow).toBeVisible({ timeout: 10_000 })

    // L3 等级 tag + 中文「已终止」tag
    await expect(firstRow.locator('.ant-tag').filter({ hasText: /^L3$/ }).first()).toBeVisible({
      timeout: 10_000,
    })
    await expect(
      pageCard.locator('.ant-table-tbody .ant-tag').filter({ hasText: /已终止/ }).first(),
    ).toBeVisible({ timeout: 10_000 })

    // Drawer Timeline 不含「创建 MR」「AI Review」
    await firstRow.getByRole('button', { name: '详情' }).click()
    const drawer = page.locator('.ant-drawer-content')
    await expect(drawer).toBeVisible({ timeout: 10_000 })

    const fullTimeline = drawer.locator('.ant-timeline').last()
    await expect(
      fullTimeline.locator('.ant-tag').filter({ hasText: /^创建 MR$/ }),
    ).toHaveCount(0)
    await expect(
      fullTimeline.locator('.ant-tag').filter({ hasText: /^AI Review$/ }),
    ).toHaveCount(0)
  })
})
