/**
 * Task 18 Phase 3A Wave 2 — 场景 6：L2 多 project
 *   → 主/从 MR description 差异 + 2 条 create_mr 事件
 *
 * 【背景】原 plan 里叫"L4 多 project"，但 L4 pipeline 只有 notify stage（base.sql 定义），
 *       不进入 fix/create_mr 阶段，无法验证主/从 MR description 差异。按 Wave 2 计划文档
 *       建议，改用 L2 pipeline 跑 2 个 project 的完整修复链路。
 *       原文件名 bug-l4-multi-project.spec.ts 含义误导，2026-04-19 重命名为 L2 以对齐实际语义；
 *       真正的 L4 场景（单 project + notify owner 人工接手）在 bug-l4-flow.spec.ts 里测。
 *
 * 流程：
 *   1. 触发 analyze → filter 返回 2 个 involvedProjects（主 PAM/pas-api + 从 PAM/pas-web）
 *   2. detail 按 project 两次调用（返回 level=l2）→ analyzer 写 2 条 scope_identified
 *   3. L2 pipeline 跑完整：
 *      - fix_bug_l2 对每个 project 各一次 runFixForProject（2 条 fix_attempt 事件）
 *      - create_mr 对每个 project 创建 MR（主仓 Closes #X、从仓 Related to PAM/pas-api#X）
 *      - ai_review 对每个 MR 一次
 *      - notify_bug
 *   4. 断言：
 *      - DB: 2 条 create_mr 事件（主 isPrimary=true, 从 isPrimary=false）
 *      - GitLab mock /_control/calls: 2 个 create-MR 请求，description 符合主/从规则
 *      - UI: BugRunsPage Timeline 能看到 2 条 "MR !N" 事件 + pipeline_success
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

interface MockCall {
  method: string
  path: string
  body: Record<string, unknown>
  timestamp: number
}

async function fetchMockCalls(request: APIRequestContext): Promise<MockCall[]> {
  const r = await request.get(`${GITLAB_MOCK}/_control/calls`)
  expect(r.ok()).toBe(true)
  return (await r.json()) as MockCall[]
}

test.describe('多 project 修复 → 主/从 MR description 差异', () => {
  test.beforeEach(async ({ request }) => {
    await resetPerTest(request, GITLAB_MOCK)
  })

  test('L2 2 project → 2 条 create_mr；主 Closes #N，从 Related to <primary>#N', async ({
    request,
    page,
  }) => {
    await loginAsAdmin(request)

    const plRows = await dbQuery<{ id: number }>(
      `SELECT id FROM product_lines WHERE name = 'pam'`,
    )
    expect(plRows.length).toBe(1)
    const productLineId = plRows[0].id

    // ── 1. Claude mock：filter 返回 2 个 project，detail 按 project seed 两次 ──
    await seedClaudeMock(request, 'analyze_bug-filter', {
      involvedProjects: [
        { projectPath: 'PAM/pas-api', isPrimary: true, sourceBranch: 'test' },
        { projectPath: 'PAM/pas-web', isPrimary: false, sourceBranch: 'test' },
      ],
      primaryProjectPath: 'PAM/pas-api',
    })
    // 第一次 detail（主仓）
    await seedClaudeMock(request, 'analyze_bug-detail', {
      classification: 'bug',
      level: 'l2',
      confidence: 'high',
      confidenceScore: 0.85,
      rootCause: {
        type: 'code',
        summary: '跨服务字段不一致',
        file: 'UserDTO.java',
        lineRange: [20, 30],
      },
      solutions: [
        { id: 'a', summary: '后端补字段', recommended: true, risk: 'low', effort: 'low' },
      ],
      affectedModules: ['user'],
      analysisSteps: ['读代码'],
      markdown: '# L2 分析（主仓）',
    })
    // 第二次 detail（从仓）
    await seedClaudeMock(request, 'analyze_bug-detail', {
      classification: 'bug',
      level: 'l2',
      confidence: 'high',
      confidenceScore: 0.85,
      rootCause: {
        type: 'code',
        summary: '前端字段未同步',
        file: 'UserForm.tsx',
        lineRange: [15, 25],
      },
      solutions: [
        { id: 'a', summary: '前端同步字段', recommended: true, risk: 'low', effort: 'low' },
      ],
      affectedModules: ['user-ui'],
      analysisSteps: ['读前端代码'],
      markdown: '# L2 分析（从仓）',
    })
    // fix：两个 project 各一次
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
    // review：2 个 MR 各一次（mock GitLab 自增 mrCounter → 1, 2）
    await seedClaudeMock(request, 'review-1', { label: 'ai-approved', summary: 'LGTM' })
    await seedClaudeMock(request, 'review-2', { label: 'ai-approved', summary: 'LGTM' })

    // ── 2. 触发链路（同步） ────────────────────────────────────────────────
    test.setTimeout(60_000)
    const dispatch = await request.post('/admin/_e2e/analyze-and-dispatch', {
      data: { productLineId, message: 'L2 2 项目联动 Bug' },
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

    // ── 3. DB 断言：status=pipeline_success + 2 条 create_mr ──────────────
    const reportRows = await dbQuery<{ status: string }>(
      `SELECT status FROM bug_analysis_reports WHERE id = $1`,
      [reportId],
    )
    expect(reportRows[0].status).toBe('pipeline_success')

    const createMrEvents = await dbQuery<{
      project_path: string
      status: string
      data: Record<string, unknown>
    }>(
      `SELECT project_path, status, data FROM bug_fix_events
       WHERE report_id = $1 AND code = 'create_mr' ORDER BY id`,
      [reportId],
    )
    expect(createMrEvents.length).toBe(2)
    const primaryMr = createMrEvents.find(e => e.project_path === 'PAM/pas-api')
    const secondaryMr = createMrEvents.find(e => e.project_path === 'PAM/pas-web')
    expect(primaryMr?.status).toBe('success')
    expect(secondaryMr?.status).toBe('success')
    expect(primaryMr?.data.isPrimary).toBe(true)
    expect(secondaryMr?.data.isPrimary).toBe(false)
    const primaryMrIid = primaryMr!.data.mrIid as number
    const secondaryMrIid = secondaryMr!.data.mrIid as number
    expect(typeof primaryMrIid).toBe('number')
    expect(typeof secondaryMrIid).toBe('number')

    // Issue iid（用于断言 description 里的 #N）
    const issueRows = await dbQuery<{ data: Record<string, unknown> }>(
      `SELECT data FROM bug_fix_events WHERE report_id = $1 AND code = 'create_issue' LIMIT 1`,
      [reportId],
    )
    expect(issueRows.length).toBe(1)
    const issueIid = issueRows[0].data.issueIid as number

    // ── 4. GitLab mock /_control/calls 断言 MR description 差异 ───────────
    const calls = await fetchMockCalls(request)
    // 过滤 create-MR 请求：POST /api/v4/projects/<path>/merge_requests
    // 注意 Express 已解码 params，所以 path 是 "/api/v4/projects/PAM%2Fpas-api/merge_requests"
    // 但 buildOverrideKey 做过 decodeURIComponent——这里我们直接匹配 raw path 里带 %2F。
    const mrCreateCalls = calls.filter(c => {
      if (c.method !== 'POST') return false
      return /\/api\/v4\/projects\/[^/]+\/merge_requests$/.test(c.path)
    })
    expect(mrCreateCalls.length).toBe(2)

    const primaryCall = mrCreateCalls.find(c => decodeURIComponent(c.path).includes('PAM/pas-api'))
    const secondaryCall = mrCreateCalls.find(c =>
      decodeURIComponent(c.path).includes('PAM/pas-web'),
    )
    expect(primaryCall, '应有主仓 MR create 请求').toBeTruthy()
    expect(secondaryCall, '应有从仓 MR create 请求').toBeTruthy()

    const primaryDesc = String(primaryCall!.body.description ?? '')
    const secondaryDesc = String(secondaryCall!.body.description ?? '')
    expect(primaryDesc).toContain(`Closes #${issueIid}`)
    expect(secondaryDesc).toContain(`Related to PAM/pas-api#${issueIid}`)
    // 主仓 description 不应该出现 Related to（互斥）
    expect(primaryDesc).not.toContain('Related to')
    // 从仓 description 不应出现 Closes
    expect(secondaryDesc).not.toContain('Closes #')

    // ── 5. UI 断言：Timeline 2 条 MR 引用 + pipeline_success 徽标 ─────────
    const loginResp = await page.request.post('/admin/auth/login', {
      data: { username: 'admin', password: 'admin' },
    })
    expect(loginResp.ok()).toBe(true)

    await page.goto(`/bug-runs?productLine=${productLineId}`)
    const pageCard = page.locator('.ant-card').filter({ hasText: 'Bug 修复实例' }).first()
    await expect(pageCard).toBeVisible({ timeout: 10_000 })

    const firstRow = pageCard.locator('.ant-table-tbody tr.ant-table-row').first()
    await expect(firstRow).toBeVisible({ timeout: 10_000 })

    // L2 等级 + 中文「Pipeline 成功」
    await expect(firstRow.locator('.ant-tag').filter({ hasText: /^L2$/ }).first()).toBeVisible({
      timeout: 10_000,
    })
    await expect(
      pageCard.locator('.ant-table-tbody .ant-tag').filter({ hasText: /Pipeline 成功/ }).first(),
    ).toBeVisible({ timeout: 10_000 })

    // Drawer Timeline 至少有 2 个「创建 MR」事件（多 project 2 个 MR）
    await firstRow.getByRole('button', { name: '详情' }).click()
    const drawer = page.locator('.ant-drawer-content')
    await expect(drawer).toBeVisible({ timeout: 10_000 })

    const fullTimeline = drawer.locator('.ant-timeline').last()
    await expect(
      fullTimeline.locator('.ant-tag').filter({ hasText: /^创建 MR$/ }),
    ).toHaveCount(2, { timeout: 10_000 })

    // Timeline 内应能看到两个 project path
    await expect(fullTimeline.getByText('PAM/pas-api').first()).toBeVisible({ timeout: 10_000 })
    await expect(fullTimeline.getByText('PAM/pas-web').first()).toBeVisible({ timeout: 10_000 })
  })
})
