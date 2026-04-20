/**
 * handover-mvp V1 AC4 — fix-runner 跨调用幂等（已 success 的 project 不被重跑）。
 *
 * ⚠️ AC4 语义偏离声明（2026-04-20 与主 agent 讨论后保留）：
 *   V1 spec 原 AC4 措辞是"Pipeline 阶段重试幂等"——假设 capability stage 失败后
 *   executor 会自动 retry 同一 stage。但当前 executor 实现（src/pipeline/executor.ts
 *   的 capability stage 分支）不做 stage-level retry 循环（仅 script stage 有）。
 *   因此"stage 级重试幂等"场景在现有代码里无路径可触达，原意不可直接 e2e 测。
 *
 *   V2 spec（docs/superpowers/specs/2026-04-19-bug-fix-workflow-v2-design.md）
 *   通过 revise-pipeline 机制以"启一条新 Pipeline"的方式实现类似效果，不依赖
 *   executor 的 stage retry。V2 实施后本 spec 的断言应迁移到 revise-pipeline 路径。
 *
 *   本 spec 覆盖的是**AC4 的核心价值**：fix-runner 自身的跨调用幂等逻辑
 *   （fix-runner.ts:65-72）——外部多次触发 fix_bug_l2 时，已存在 success
 *   fix_attempt 的 project 会被跳过。触发路径靠 _e2e/trigger-capability 测试路由
 *   （仅 E2E_MODE 生效）直接调 handler，绕过 Pipeline executor。
 *
 *   硬约束：不可改 executor.ts（严益昌原创 6 文件零改动），workaround 保留。
 *
 * 业务背景（与原 AC4 措辞的对齐）：
 *   当前 MVP 下 Pipeline capability stage 执行器（executor.ts:287-319）不做 retry，
 *   即 capability stage retryCount 在 "stage 级重试" 意义下不生效。fix-runner 自身
 *   仍保留"跨调用幂等"逻辑（fix-runner.ts:65-72）：外部多次触发 fix_bug_l2 时，
 *   已存在 success fix_attempt 的 project 会被跳过，只重跑失败的 project。
 *   本 spec 覆盖该幂等语义（AC4 的核心价值：已成功 project 不被重跑）。
 *
 * 触发方式：
 *   先正常走一次 analyze-and-dispatch（第一次 fix_bug_l2 通过 Pipeline 执行），
 *   然后手动调 _e2e/trigger-capability 再触发一次 fix_bug_l2 验证幂等。
 *
 * 场景：
 *   1. seed：L2 pipeline + 2 project（PAM/pas-api 主 + PAM/pas-web 从）
 *   2. 第一次触发（通过 Pipeline）：
 *      - fix-PAM/pas-api 第 1 条 mock → testPassed=true → A 写 1 条 fix_attempt(success)
 *      - fix-PAM/pas-web 第 1 条 mock → testPassed=false → B 写 1 条 fix_attempt(failed)
 *      - fix_bug_l2 返回 failed → Pipeline capability stage 直接停，不 retry
 *      - coordinator fix_exhausted → handover（report.status='pending_manual'）
 *   3. 测试层再次调用 fix_bug_l2（模拟 retry）：
 *      - A：findByReportCode 查到已有 success fix_attempt → 幂等跳过，不 popMock
 *      - B：没 success fix_attempt → popMock 第 2 条（testPassed=true） → 写 B fix_attempt(success)
 *   4. 断言：
 *      - A 全部仅 1 条 fix_attempt（status=success）
 *      - B 共 2 条（1 failed，1 success）
 *      - fix-PAM/pas-api 的 mock 队列应有 1 条未被消费（用 seed 2 条，确认幂等时 A 不 pop）
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

test.describe('fix-runner 跨调用幂等（AC4）', () => {
  test.beforeEach(async ({ request }) => {
    await resetPerTest(request, GITLAB_MOCK)
  })

  test('L2 多 project：第一次 A 成功 B 失败 → 再次触发 fix_bug_l2，A 跳过不重跑', async ({
    request,
  }) => {
    await loginAsAdmin(request)

    const plRows = await dbQuery<{ id: number }>(
      `SELECT id FROM product_lines WHERE name = 'pam'`,
    )
    expect(plRows.length).toBe(1)
    const productLineId = plRows[0].id

    // ── 1. mock：filter 返回 2 个 project；detail 两次；fix 按 project 队列 ──
    await seedClaudeMock(request, 'analyze_bug-filter', {
      involvedProjects: [
        { projectPath: 'PAM/pas-api', isPrimary: true, sourceBranch: 'test' },
        { projectPath: 'PAM/pas-web', isPrimary: false, sourceBranch: 'test' },
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

    // fix 队列（显式多 seed 一条 A 的成功响应，用于"消费检测"——若幂等失败而 A 被
    // 重新 pop，第二次也会 success，fix_attempt 会变 2 条；幂等生效时第二次 seed 不被消费）。
    await seedClaudeMock(request, 'fix-PAM/pas-api', {
      branch: 'fix/issue-1-pas-api',
      testPassed: true,
      output: '所有测试通过（第一次）',
    })
    // 守望响应：若幂等失效，A 会 pop 此条（testPassed=false 便于检测到）——此处我们用
    // testPassed=true 保持与首条一致，只通过 fix_attempt 计数判断幂等。
    await seedClaudeMock(request, 'fix-PAM/pas-api', {
      branch: 'fix/issue-1-pas-api',
      testPassed: true,
      output: '若幂等失效，A 会再 pop 并写 1 条 fix_attempt',
    })
    await seedClaudeMock(request, 'fix-PAM/pas-web', {
      branch: 'fix/issue-1-pas-web',
      testPassed: false,
      error: 'attempt 1：前端单测挂',
      output: '测试未通过',
    })
    await seedClaudeMock(request, 'fix-PAM/pas-web', {
      branch: 'fix/issue-1-pas-web',
      testPassed: true,
      output: '所有测试通过（第二次）',
    })
    // review 队列：第二次 fix_bug_l2 成功后 Pipeline 后续 stage 不会跑（本测试只
    // 调 fix_bug_l2 capability，不跑 Pipeline），所以不需要 review mock。

    // ── 2. 第一次触发（通过 Pipeline） ───────────────────────────────
    test.setTimeout(120_000)
    const dispatch = await request.post('/admin/_e2e/analyze-and-dispatch', {
      data: { productLineId, message: 'L2 多 project retry 幂等用例' },
    })
    expect(dispatch.ok()).toBe(true)
    const dispatchBody = await dispatch.json()
    expect(dispatchBody.success).toBe(true)
    const { reportId } = dispatchBody.data as { reportId: number }

    // 第一次结果：A 1 条 success，B 1 条 failed；report fix_exhausted → pending_manual
    let fixAttempts = await dbQuery<{ status: string; project_path: string | null }>(
      `SELECT status, project_path FROM bug_fix_events
       WHERE report_id = $1 AND code = 'fix_attempt' ORDER BY id`,
      [reportId],
    )
    expect(fixAttempts.filter(e => e.project_path === 'PAM/pas-api').length).toBe(1)
    expect(fixAttempts.filter(e => e.project_path === 'PAM/pas-api')[0].status).toBe('success')
    expect(fixAttempts.filter(e => e.project_path === 'PAM/pas-web').length).toBe(1)
    expect(fixAttempts.filter(e => e.project_path === 'PAM/pas-web')[0].status).toBe('failed')

    // ── 3. 手动再触发一次 fix_bug_l2（模拟 retry） ────────────────────
    const retrigger = await request.post('/admin/_e2e/trigger-capability', {
      data: {
        capabilityKey: 'fix_bug_l2',
        extraParams: { reportId },
      },
    })
    expect(retrigger.ok()).toBe(true)
    const retrigBody = await retrigger.json()
    expect(retrigBody.ok).toBe(true)
    // 第二次成功（A 幂等跳过 + B 成功）
    expect(retrigBody.result.success).toBe(true)

    // ── 4. 断言幂等语义 ───────────────────────────────────────────────
    fixAttempts = await dbQuery<{ status: string; project_path: string | null }>(
      `SELECT status, project_path FROM bug_fix_events
       WHERE report_id = $1 AND code = 'fix_attempt' ORDER BY id`,
      [reportId],
    )
    const aAttempts = fixAttempts.filter(e => e.project_path === 'PAM/pas-api')
    const bAttempts = fixAttempts.filter(e => e.project_path === 'PAM/pas-web')

    // A：幂等关键断言——仍然只有 1 条 fix_attempt（没有因第二次触发多出一条）
    expect(aAttempts.length, 'project A 幂等：fix_attempt 应保持 1 条').toBe(1)
    expect(aAttempts[0].status).toBe('success')

    // B：2 条（第 1 次 failed + 第 2 次 success）
    expect(bAttempts.length, 'project B 应有 2 条 fix_attempt（failed + success）').toBe(2)
    expect(bAttempts[0].status).toBe('failed')
    expect(bAttempts[1].status).toBe('success')
  })
})
