/**
 * handover-mvp T4 修订 — L4 不再走 L4-复杂问题 Pipeline，改由 coordinator 直接
 * checkAndTriggerHandover(reason='l4_manual')，同一事件模型下覆盖 L4 → handover 路径。
 *
 * 新路径流程（commit 445409e）：
 *   1. filter 返回 1 个 project（PAM/pas-api, primary）
 *   2. detail 返回 classification='bug', level='l4'
 *   3. handleAnalysisComplete 见 level='l4' → 直接 checkAndTriggerHandover('l4_manual')
 *      - request_handover：打 needs-manual label + 写 handover 事件 + status='pending_manual'
 *      - notify_bug：decideScenario 见 handover 事件 → kind='handover' → DM owner
 *   4. 断言：
 *      - DB: report.status='pending_manual' + level='l4'（不再是 pipeline_success）
 *      - DB: 事件流含 analysis / scope_identified / create_issue / handover / notify
 *             handover.data.reason='l4_manual'、fixBranch='fix/issue-N'
 *             notify.data.messageKind='handover'
 *             不含 fix_attempt / create_mr / ai_review
 *      - MockIMAdapter DM 含「架构级」「AI 放弃自动修复」「needs-manual」「fix/issue-」关键词
 *      - UI: BugRunsPage 显示 L4 tag + pending_manual tag
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

test.describe('L4 架构级 Bug → handover 路径（不再走 L4 Pipeline）', () => {
  test.beforeEach(async ({ request }) => {
    await resetPerTest(request, GITLAB_MOCK)
  })

  test('L4 → checkAndTriggerHandover(l4_manual) → pending_manual + handover 事件 + owner DM', async ({ request, page }) => {
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
    // 3.1 report 终态：pending_manual（而不是 pipeline_success）
    const reportRows = await dbQuery<{ status: string; level: string }>(
      `SELECT status, level FROM bug_analysis_reports WHERE id = $1`,
      [reportId],
    )
    expect(reportRows[0].status).toBe('pending_manual')
    expect(reportRows[0].level).toBe('l4')

    // 3.2 事件流：应有 analysis / scope_identified / create_issue / handover / notify
    const events = await dbQuery<{ code: string; status: string; data: Record<string, unknown> }>(
      `SELECT code, status, data FROM bug_fix_events WHERE report_id = $1 ORDER BY id`,
      [reportId],
    )
    const codes = events.map(e => e.code)
    expect(codes).toContain('analysis')
    expect(codes).toContain('scope_identified')
    expect(codes).toContain('create_issue')
    expect(codes).toContain('handover')
    expect(codes).toContain('notify')
    // L4（新路径）不应有 fix_attempt / create_mr / ai_review
    expect(codes).not.toContain('fix_attempt')
    expect(codes).not.toContain('create_mr')
    expect(codes).not.toContain('ai_review')

    // 3.3 handover 事件详情
    const handoverEvt = events.find(e => e.code === 'handover' && e.status === 'success')
    expect(handoverEvt, '应有 code=handover status=success 事件').toBeTruthy()
    expect(handoverEvt!.data.reason).toBe('l4_manual')
    expect(String(handoverEvt!.data.fixBranch)).toMatch(/^fix\/issue-\d+/)
    // 新路径对 L4 单 project 场景：labelAdded=true（mock GitLab 兜底返回 ok）
    expect(handoverEvt!.data.labelAdded).toBe(true)

    // 3.4 notify 事件详情：messageKind=handover（不再是 l4_created）
    const notifyEvents = events.filter(e => e.code === 'notify')
    expect(notifyEvents.length).toBeGreaterThanOrEqual(1)
    const notifyToPrimary = notifyEvents.find(
      e => e.data.userId === 'u-primary' && e.data.messageKind === 'handover',
    )
    expect(notifyToPrimary, '应有一条 notify 事件 messageKind=handover 发给 u-primary').toBeTruthy()
    expect(notifyToPrimary!.status).toBe('success')

    // ── 4. MockIMAdapter 断言：u-primary 收到 handover 文案 DM ────────
    const messages = await fetchMessages(request, { kind: 'direct', to: 'u-primary' })
    expect(messages.length).toBeGreaterThanOrEqual(1)
    // handover DM 的特征文案：needs-manual + fix/issue- + "架构级" + "AI 放弃自动修复"
    const handoverMsg = messages.find(m => {
      const t = m.text ?? ''
      return t.includes('needs-manual') && t.includes('fix/issue-') && t.includes('架构级')
    })
    expect(handoverMsg, 'u-primary 应收到 handover 文案 DM').toBeTruthy()
    expect(handoverMsg!.text).toContain('AI 放弃自动修复')

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
    // pending_manual 状态 tag（不再是 pipeline_success）
    await expect(
      page.locator('.ant-tag').filter({ hasText: /^pending_manual$/ }).first(),
    ).toBeVisible({ timeout: 10_000 })

    // Timeline 应该有"通知"事件（handover kind 也走 notify event）
    await expect(page.locator('.ant-timeline').getByText(/通知|notify/).first()).toBeVisible({
      timeout: 10_000,
    })
  })
})
