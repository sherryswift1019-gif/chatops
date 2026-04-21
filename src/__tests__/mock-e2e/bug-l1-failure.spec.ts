/**
 * Task 18 Phase 3A — 场景 1：L1 修复失败 → 触发 handover（MVP 后更新：pending_manual）
 *
 * ⚠️ 2026-04-20 update（handover MVP T5 之后）：
 *   T5 commit（6c8b25a / a78230a）修改了 coordinator.onComplete(failed) 路径：
 *   fix_attempt 失败时不再直接置 aborted，而是走 checkAndTriggerHandover(fix_exhausted)
 *   → report.status = 'pending_manual'。原 spec 断言 status='aborted' 已不成立。
 *   本次 spec 对齐 T5：断言 status='pending_manual'，UI Tag=pending_manual，
 *   DB 事件流多一条 handover 事件。
 *
 * 流程：
 *   1. 触发 analyze_bug → level=l1
 *   2. L1 pipeline 第一个 stage fix_bug_l1 fix 失败（runFixForProject 返回 testPassed=false）
 *   3. fix_bug_l1 stage retryCount=0 + onFailure=stop → pipeline failed
 *   4. coordinator.onComplete(failed) 检测 fix_attempt(failed) 存在 → 触发 handover(fix_exhausted)
 *      → request_handover 写 handover 事件 + status=pending_manual + GitLab label needs-manual
 *      → notify_bug(kind='handover') 给各 project owner 发 DM
 *   5. UI 打开 BugRunsPage：report 状态徽标 "pending_manual"（warning 橙色），
 *      EventTimeline 含 "❌ ... 修复" 文案和 handover 事件
 *   6. DB 断言：events 含 analysis / scope_identified / create_issue / fix_attempt(failed) /
 *      handover(success) / notify；不含 create_mr / ai_review
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

test.describe('L1 修复失败 → handover (pending_manual)', () => {
  test.beforeEach(async ({ request }) => {
    await resetPerTest(request, GITLAB_MOCK)
  })

  test('analyze → L1 pipeline fix 失败 → handover(pending_manual) + UI 显示 warning 标签', async ({ request, page }) => {
    await loginAsAdmin(request)

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
    // fix 失败：testPassed=false（fix_bug_l1 retryCount=0 → 一次失败即 stop）
    await seedClaudeMock(request, 'fix-PAM/pas-api', {
      branch: 'fix/issue-1-pas-api',
      testPassed: false,
      error: '编译错误：SomeClass cannot be resolved',
      output: '编译错误，测试未通过',
    })
    // 补发 notify_bug：fix_failed 场景 shouldNotifyOwners=false，不会真发 DM，
    // 但保险起见给 review 也一个 fallback（代码路径里补发 notify 不走 review）

    // ── 2. 触发链路（同步：handleAnalysisComplete await runPipeline） ───────
    test.setTimeout(60_000)
    const dispatch = await request.post('/admin/_e2e/analyze-and-dispatch', {
      data: { productLineId, message: 'L1 失败用例：配置补了依然编不过' },
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

    // ── 3. DB 断言：状态 pending_manual（T5 后），events 含 fix_attempt=failed + handover，
    //        不含 create_mr（Pipeline 失败中断）──
    const reportRows = await dbQuery<{ status: string; pipeline_run_id: number }>(
      `SELECT status, pipeline_run_id FROM bug_analysis_reports WHERE id = $1`,
      [reportId],
    )
    expect(reportRows[0].status).toBe('pending_manual')

    const events = await dbQuery<{ code: string; status: string; project_path: string | null }>(
      `SELECT code, status, project_path FROM bug_fix_events WHERE report_id = $1 ORDER BY id`,
      [reportId],
    )
    const codes = events.map(e => e.code)
    for (const expected of ['analysis', 'scope_identified', 'create_issue', 'fix_attempt', 'handover']) {
      expect(codes, `events 缺少 ${expected}`).toContain(expected)
    }
    // 失败后应无 MR / review（pipeline onFailure=stop）
    expect(codes).not.toContain('create_mr')
    expect(codes).not.toContain('ai_review')

    // fix_attempt 必须是 failed
    const fixAttempt = events.find(e => e.code === 'fix_attempt')
    expect(fixAttempt?.status).toBe('failed')
    expect(fixAttempt?.project_path).toBe('PAM/pas-api')

    // ── 4. UI：BugRunsPage 状态徽标 "pending_manual" + 失败事件 ────────────────────
    const loginResp = await page.request.post('/admin/auth/login', {
      data: { username: 'admin', password: 'admin' },
    })
    expect(loginResp.ok()).toBe(true)

    // Table + Drawer 新 UI
    await page.goto(`/bug-runs?productLine=${productLineId}`)
    const pageCard = page.locator('.ant-card').filter({ hasText: 'Bug 修复实例' }).first()
    await expect(pageCard).toBeVisible({ timeout: 10_000 })

    const firstRow = pageCard.locator('.ant-table-tbody tr.ant-table-row').first()
    await expect(firstRow).toBeVisible({ timeout: 10_000 })

    // 状态 Tag "待人工接手"（T5 后 fix 失败进入 handover 路径，对应 pending_manual）
    await expect(
      pageCard.locator('.ant-table-tbody .ant-tag').filter({ hasText: /待人工接手/ }).first(),
    ).toBeVisible({ timeout: 10_000 })

    // 打开 Drawer：Section 5 Timeline 含「修复尝试」codeLabel（对应 fix_attempt 事件）
    await firstRow.getByRole('button', { name: '详情' }).click()
    const drawer = page.locator('.ant-drawer-content')
    await expect(drawer).toBeVisible({ timeout: 10_000 })

    const fullTimeline = drawer.locator('.ant-timeline').last()
    await expect(fullTimeline.locator('.ant-tag').filter({ hasText: /^分析$/ }).first()).toBeVisible({
      timeout: 10_000,
    })
    await expect(
      fullTimeline.locator('.ant-tag').filter({ hasText: /^修复尝试$/ }).first(),
    ).toBeVisible({ timeout: 10_000 })
    // 失败的 fix_attempt 会带 PAM/pas-api 的 Text code
    await expect(fullTimeline.getByText('PAM/pas-api').first()).toBeVisible({ timeout: 10_000 })
  })
})
