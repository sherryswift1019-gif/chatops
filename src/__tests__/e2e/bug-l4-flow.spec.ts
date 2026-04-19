/**
 * Task 18 后续修订 — L4 通知澄清：
 *   L4 = Claude 分析后判定无法自动修复，仅建 Issue 并通知涉及 project owner 人工接手
 *
 * 和 bug-l2-multi-project.spec.ts（原名 bug-l4-multi-project）的区别：
 *   - 那个实际是 L2（多 project 走完整 fix→MR→review→notify 链路）
 *   - 本 spec 才是真正的 L4：单 project / 单 Pipeline stage(notify_bug) / 发 owner DM / UI 能看到 L4 tag
 *
 * 流程：
 *   1. filter 返回 1 个 project（PAM/pas-api, primary）
 *   2. detail 返回 classification='bug', level='l4'
 *   3. handleAnalysisComplete 触发 L4 pipeline（base.sql 里只有 notify_bug 一个 stage）
 *   4. notify_bug handler:
 *      - scenario 判定为 l4_created（classification='bug' + level='l4' + 无 MR）
 *      - shouldNotifyOwners('l4_created')=true → 给 u-primary（PAM/pas-api owner）发 DM
 *      - 写 bug_fix_events(code='notify', status='success', data.userId='u-primary')
 *   5. 断言：
 *      - DB: report.status='pipeline_success' + level='l4'
 *      - DB: 事件流含 analysis / scope_identified / create_issue / notify；不含 fix_attempt / create_mr / ai_review
 *      - MockIMAdapter: /admin/_e2e/messages?kind=direct&to=u-primary 含 "L4" / "无法自动修复" 文案
 *      - UI: BugRunsPage 显示 L4 tag + pipeline_success + Timeline 有"通知"事件
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

test.describe('L4 架构级 Bug 单 project 通知 owner 人工接手', () => {
  test.beforeEach(async ({ request }) => {
    await resetPerTest(request, GITLAB_MOCK)
  })

  test('L4 → 仅建 Issue + notify owner DM + UI 展示 L4 tag', async ({ request, page }) => {
    await loginAsAdmin(request)

    const plRows = await dbQuery<{ id: number }>(
      `SELECT id FROM product_lines WHERE name = 'pam'`,
    )
    expect(plRows.length).toBe(1)
    const productLineId = plRows[0].id

    // ── 1. Claude mock：filter 返回 1 个 project，detail 返回 L4 ──────────
    await seedClaudeMock(request, 'analyze_bug-filter', {
      involvedProjects: [
        { projectPath: 'PAM/pas-api', isPrimary: true, sourceBranch: 'test' },
      ],
      primaryProjectPath: 'PAM/pas-api',
    })
    await seedClaudeMock(request, 'analyze_bug-detail', {
      classification: 'bug',
      level: 'l4',
      confidence: 'medium',
      confidenceScore: 0.6,
      rootCause: {
        type: 'architecture',
        summary: '涉及核心消息队列重构，非简单代码修复可解决',
        file: 'mq/core/Broker.java',
        lineRange: [1, 100],
      },
      solutions: [
        {
          id: 'a',
          summary: '需要人工评估队列重构影响范围',
          recommended: true,
          risk: 'high',
          effort: 'high',
        },
      ],
      affectedModules: ['mq-core', 'mq-client', 'consumer'],
      analysisSteps: ['读代码', '确认涉及 3+ 模块', '判定 L4'],
      markdown: '# L4 架构级分析\n\n此 bug 涉及核心消息队列重构，建议人工接手。',
    })

    // ── 2. 触发链路（同步） ────────────────────────────────────────────
    test.setTimeout(60_000)
    const dispatch = await request.post('/admin/_e2e/analyze-and-dispatch', {
      data: { productLineId, message: 'L4 架构级 Bug 样例' },
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
    expect(level).toBe('l4')

    // ── 3. DB 断言 ──────────────────────────────────────────────────
    // 3.1 report 终态
    const reportRows = await dbQuery<{ status: string; level: string }>(
      `SELECT status, level FROM bug_analysis_reports WHERE id = $1`,
      [reportId],
    )
    expect(reportRows[0].status).toBe('pipeline_success')
    expect(reportRows[0].level).toBe('l4')

    // 3.2 事件流：应有 analysis / scope_identified / create_issue / notify
    const events = await dbQuery<{ code: string; status: string; data: Record<string, unknown> }>(
      `SELECT code, status, data FROM bug_fix_events WHERE report_id = $1 ORDER BY id`,
      [reportId],
    )
    const codes = events.map(e => e.code)
    expect(codes).toContain('analysis')
    expect(codes).toContain('scope_identified')
    expect(codes).toContain('create_issue')
    expect(codes).toContain('notify')
    // L4 不应有 fix_attempt / create_mr / ai_review
    expect(codes).not.toContain('fix_attempt')
    expect(codes).not.toContain('create_mr')
    expect(codes).not.toContain('ai_review')

    // 3.3 notify 事件详情
    const notifyEvents = events.filter(e => e.code === 'notify')
    expect(notifyEvents.length).toBeGreaterThanOrEqual(1)
    const notifyToPrimary = notifyEvents.find(e => e.data.userId === 'u-primary')
    expect(notifyToPrimary, '应有一条 notify 事件发给 PAM/pas-api 的 owner u-primary').toBeTruthy()
    expect(notifyToPrimary!.status).toBe('success')
    expect(notifyToPrimary!.data.messageKind).toBe('l4_created')

    // ── 4. MockIMAdapter 断言：u-primary 收到 L4 文案 DM ──────────────
    const messages = await fetchMessages(request, { kind: 'direct', to: 'u-primary' })
    expect(messages.length).toBeGreaterThanOrEqual(1)
    const l4Msg = messages.find(m => (m.text ?? '').includes('L4'))
    expect(l4Msg, 'u-primary 应收到 L4 文案的 direct message').toBeTruthy()
    expect(l4Msg!.text).toContain('无法自动修复')
    expect(l4Msg!.text).toContain('Issue:')

    // ── 5. UI 断言 ───────────────────────────────────────────────────
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

    // L4 等级 tag
    await expect(page.locator('.ant-tag').filter({ hasText: /^L4$/ }).first()).toBeVisible({
      timeout: 10_000,
    })
    // pipeline_success 状态 tag
    await expect(
      page.locator('.ant-tag').filter({ hasText: /^pipeline_success$/ }).first(),
    ).toBeVisible({ timeout: 10_000 })

    // Timeline 应该有"通知"事件
    await expect(page.locator('.ant-timeline').getByText(/通知|notify/).first()).toBeVisible({
      timeout: 10_000,
    })
  })
})
