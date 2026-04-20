/**
 * handover-mvp V2 MVP AC-V2-2 — Pipeline fix 阶段 retryCount 耗尽 → fix_exhausted handover。
 *
 * 场景：L2 bug 触发 → L2-代码缺陷 Pipeline → fix_bug_l2 stage（retryCount=2，共 3 次）
 * 每次 runFixForProject 都返回 testPassed=false → 3 条 fix_attempt(failed) →
 * stage 失败 + onFailure=stop → pipeline 整体 failed。
 *
 * coordinator.onComplete(failed)：
 *   - 查最近 approval 事件 → 无（未审批）
 *   - scope_identified + fix_attempt 做 fix_exhausted 判定：
 *     存在 project 从未 success 过任何 fix_attempt → fixExhausted=true
 *   - 调 checkAndTriggerHandover(reason='fix_exhausted', context={failedStage:'fix_bug_l2',attemptCount:3})
 *     → request_handover（打 label + 写 handover 事件 + status='pending_manual'）
 *     → notify_bug（kind='handover' → owner DM）
 *
 * 断言（本 spec 重点）：
 *   - fix_attempt 事件 ≥1 条 status=failed
 *   - handover 事件 status=success, reason=fix_exhausted, failedStage=fix_bug_l2, attemptCount>=1
 *   - report.status='pending_manual'
 *   - owner DM 文案含 'AI 修复多次未通过' 或 'fix/issue-' 或 'needs-manual'
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

test.describe('Pipeline fix 阶段耗尽 → fix_exhausted handover', () => {
  test.beforeEach(async ({ request }) => {
    await resetPerTest(request, GITLAB_MOCK)
  })

  test('L2 bug + fix 3 轮全败 → coordinator 触发 handover(fix_exhausted) → pending_manual', async ({
    request,
  }) => {
    await loginAsAdmin(request)

    const plRows = await dbQuery<{ id: number }>(
      `SELECT id FROM product_lines WHERE name = 'pam'`,
    )
    expect(plRows.length).toBe(1)
    const productLineId = plRows[0].id

    // ── 1. Claude mock：analyze 成功，fix 3 次全部失败 ──────────────────
    await seedClaudeMock(request, 'analyze_bug-filter', {
      involvedProjects: [
        { projectPath: 'PAM/pas-api', isPrimary: true, sourceBranch: 'test' },
      ],
      primaryProjectPath: 'PAM/pas-api',
    })
    await seedClaudeMock(request, 'analyze_bug-detail', {
      classification: 'bug',
      level: 'l2',
      confidence: 'high',
      confidenceScore: 0.85,
      rootCause: {
        type: 'code',
        summary: '空指针异常（fix 难以自动修）',
        file: 'UserService.java',
        lineRange: [42, 42],
      },
      solutions: [
        { id: 'a', summary: '加 null 判断', recommended: true, risk: 'low', effort: 'low' },
      ],
      affectedModules: ['user'],
      analysisSteps: ['读代码', '定位异常栈'],
      markdown: '# L2 分析\n空指针',
    })
    // L2 pipeline fix_bug_l2 stage retryCount=2 → 共 3 次。seed 3 条 mock 全败。
    for (let i = 0; i < 3; i++) {
      await seedClaudeMock(request, 'fix-PAM/pas-api', {
        branch: `fix/issue-1-pas-api`,
        testPassed: false,
        error: `attempt ${i + 1} 失败：单测一直挂`,
        output: '测试未通过',
      })
    }

    // ── 2. 触发链路（同步：runPipeline + coordinator.onComplete 全部跑完） ──
    test.setTimeout(120_000)
    const dispatch = await request.post('/admin/_e2e/analyze-and-dispatch', {
      data: { productLineId, message: 'L2 bug fix 3 轮都失败用例' },
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
    expect(level).toBe('l2')

    // ── 3. DB 断言 ───────────────────────────────────────────────────
    // 3.1 fix_attempt 事件 ≥1 条 failed
    const fixAttempts = await dbQuery<{ status: string; project_path: string | null }>(
      `SELECT status, project_path FROM bug_fix_events WHERE report_id = $1 AND code = 'fix_attempt' ORDER BY id`,
      [reportId],
    )
    expect(fixAttempts.length).toBeGreaterThanOrEqual(1)
    expect(fixAttempts.every(e => e.status === 'failed')).toBe(true)
    expect(fixAttempts.every(e => e.project_path === 'PAM/pas-api')).toBe(true)

    // 3.2 handover 事件 status=success, reason=fix_exhausted
    const handoverEvents = await dbQuery<{
      status: string
      data: Record<string, unknown>
    }>(
      `SELECT status, data FROM bug_fix_events WHERE report_id = $1 AND code = 'handover'`,
      [reportId],
    )
    expect(handoverEvents.length).toBeGreaterThanOrEqual(1)
    const handoverEvt = handoverEvents.find(e => e.status === 'success')
    expect(handoverEvt, '应有 code=handover status=success 事件').toBeTruthy()
    expect(handoverEvt!.data.reason).toBe('fix_exhausted')
    expect(handoverEvt!.data.failedAt).toBe('fix_bug_l2')
    expect(typeof handoverEvt!.data.attemptCount).toBe('number')
    expect(Number(handoverEvt!.data.attemptCount)).toBeGreaterThanOrEqual(1)
    expect(String(handoverEvt!.data.fixBranch)).toMatch(/^fix\/issue-\d+/)

    // 3.3 没有 create_mr / ai_review（fix 没成功就没到后续 stage）
    const events = await dbQuery<{ code: string }>(
      `SELECT code FROM bug_fix_events WHERE report_id = $1`,
      [reportId],
    )
    const codes = events.map(e => e.code)
    expect(codes).not.toContain('create_mr')
    expect(codes).not.toContain('ai_review')

    // 3.4 report.status='pending_manual'
    const reportRows = await dbQuery<{ status: string }>(
      `SELECT status FROM bug_analysis_reports WHERE id = $1`,
      [reportId],
    )
    expect(reportRows[0].status).toBe('pending_manual')

    // ── 4. DM 断言：u-primary（PAM/pas-api owner）收到 handover 文案 DM ──
    const messages = await fetchMessages(request, { kind: 'direct', to: 'u-primary' })
    expect(messages.length).toBeGreaterThanOrEqual(1)
    const handoverMsg = messages.find(m => {
      const t = m.text ?? ''
      // 三个关键字至少一个：'AI 修复多次未通过' / 'fix/issue-' / 'needs-manual'
      return (
        t.includes('AI 修复多次未通过') ||
        t.includes('fix/issue-') ||
        t.includes('needs-manual')
      )
    })
    expect(handoverMsg, 'u-primary 应收到 handover DM').toBeTruthy()
    // 两个强断言：至少包含 fix/issue- 分支名 + needs-manual label 提示
    expect(handoverMsg!.text).toContain('fix/issue-')
    expect(handoverMsg!.text).toContain('needs-manual')

    // 4.1 notify 事件 messageKind=handover
    const notifyEvents = await dbQuery<{ data: Record<string, unknown>; status: string }>(
      `SELECT data, status FROM bug_fix_events WHERE report_id = $1 AND code = 'notify'`,
      [reportId],
    )
    const handoverNotify = notifyEvents.find(
      e => e.status === 'success' && e.data.messageKind === 'handover',
    )
    expect(handoverNotify, '应有一条 notify 事件 messageKind=handover').toBeTruthy()
    expect(handoverNotify!.data.userId).toBe('u-primary')
  })
})
