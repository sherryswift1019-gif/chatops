/**
 * Unit test: refactored fix-runner.handleFixBug
 *
 * runFixForProject 整块被 mock，专注验证：
 *   - 多 project 串行循环
 *   - 幂等（跳过已有 success 的 project）
 *   - attempt 字段随历史递增
 *   - partial failure 返回 fix_failed 且写 failed 事件
 *   - 入参错误 / report 不存在 / 无 scope_identified 的 error 码
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resetTestDb, getTestPool } from '../helpers/db.js'
import {
  createEvent,
  findByReportCode,
} from '../../db/repositories/bug-fix-events.js'
import { createBugAnalysisReport } from '../../db/repositories/bug-analysis-reports.js'

// mock runFixForProject —— 不走真实 worktree / claude
vi.mock('../../agent/fix/fix-logic.js', () => ({
  runFixForProject: vi.fn(),
  isFixSuccessful: vi.fn(() => true),
  projectPathToGitUrl: (p: string) => `http://git.example.com/${p}.git`,
}))
import { runFixForProject } from '../../agent/fix/fix-logic.js'
import { handleFixBug } from '../../agent/fix/fix-runner.js'

interface ScopeSeed {
  path: string
  sourceBranch?: string
  affectedModules?: string[]
  isPrimary?: boolean
}

async function seedProductLine(): Promise<number> {
  const pool = getTestPool()
  const { rows } = await pool.query(
    `INSERT INTO product_lines (name, display_name, description)
     VALUES ('pam', 'PAM', 'test')
     ON CONFLICT (name) DO UPDATE SET display_name = EXCLUDED.display_name
     RETURNING id`,
  )
  return rows[0].id as number
}

async function seedReport(opts: { scopes: ScopeSeed[]; issueId?: number }): Promise<number> {
  const productLineId = await seedProductLine()
  const primary = opts.scopes.find(s => s.isPrimary) ?? opts.scopes[0]
  const report = await createBugAnalysisReport({
    issueId: opts.issueId ?? 1001,
    issueUrl: `http://git.example.com/${primary?.path ?? 'PAM/x'}/-/issues/${opts.issueId ?? 1001}`,
    productLineId,
    agentSessionId: null,
    level: 'l2',
    classification: 'bug',
    confidence: 'medium',
    confidenceScore: 0.8,
    rootCauseSummary: '根因: 示例根因',
    solutionsJson: [
      { id: 'a', summary: '修改 A', recommended: true, risk: 'low', effort: 'small' },
    ],
    affectedModules: ['auth'],
    analysisSteps: null,
    metadata: null,
    primaryProjectPath: primary?.path ?? null,
  })

  for (const s of opts.scopes) {
    await createEvent({
      reportId: report.id,
      projectPath: s.path,
      code: 'scope_identified',
      data: {
        sourceBranch: s.sourceBranch ?? 'master',
        affectedModules: s.affectedModules ?? [],
        isPrimary: s.isPrimary ?? false,
      },
    })
  }

  return report.id
}

function makeOpts(reportId: number) {
  return {
    capabilityKey: 'fix_bug_l2',
    context: {
      taskId: 't',
      groupId: 'g',
      platform: 'pipeline',
      initiatorId: 'p',
      initiatorRole: 'admin',
    },
    extraParams: { reportId },
  } as const
}

describe('fix_bug handler (refactored)', () => {
  beforeEach(async () => {
    await resetTestDb()
    vi.mocked(runFixForProject).mockReset()
  })

  it('fixes each project in scope_identified, writes fix_attempt per project', async () => {
    const reportId = await seedReport({
      scopes: [
        { path: 'PAM/pas-6.0', sourceBranch: 'master', affectedModules: ['auth'], isPrimary: true },
        { path: 'PAM/pas-api', sourceBranch: 'master', affectedModules: ['api'] },
      ],
      issueId: 100,
    })

    vi.mocked(runFixForProject).mockImplementation(async (input) => ({
      branch: `fix/issue-${input.issueId}`,
      testPassed: true,
    }))

    const result = await handleFixBug(makeOpts(reportId) as any, 'l2')

    expect(result.success).toBe(true)
    expect(runFixForProject).toHaveBeenCalledTimes(2)

    const events = await findByReportCode(reportId, 'fix_attempt')
    expect(events).toHaveLength(2)
    expect(events.every(e => e.status === 'success')).toBe(true)
    expect(new Set(events.map(e => e.projectPath))).toEqual(
      new Set(['PAM/pas-6.0', 'PAM/pas-api']),
    )
    for (const e of events) {
      const d = e.data as Record<string, unknown>
      expect(d.branch).toBe('fix/issue-100')
      expect(d.targetBranch).toBe('master')
      expect(d.testResult).toBe(true)
      expect(d.attempt).toBe(1)
    }
  })

  it('idempotent: skips project with existing successful fix_attempt', async () => {
    const reportId = await seedReport({
      scopes: [
        { path: 'PAM/pas-6.0', sourceBranch: 'master', isPrimary: true },
        { path: 'PAM/pas-api', sourceBranch: 'master' },
      ],
      issueId: 200,
    })
    // 预置 PAM/pas-6.0 的 success
    await createEvent({
      reportId,
      projectPath: 'PAM/pas-6.0',
      code: 'fix_attempt',
      status: 'success',
      data: { branch: 'fix/old', targetBranch: 'master', attempt: 1 },
    })

    vi.mocked(runFixForProject).mockResolvedValue({ branch: 'fix/new', testPassed: true })

    const result = await handleFixBug(makeOpts(reportId) as any, 'l2')

    expect(result.success).toBe(true)
    expect(runFixForProject).toHaveBeenCalledTimes(1)
    const calledWith = vi.mocked(runFixForProject).mock.calls[0][0]
    expect(calledWith.projectPath).toBe('PAM/pas-api')

    const events = await findByReportCode(reportId, 'fix_attempt')
    expect(events).toHaveLength(2)
    const apiEvent = events.find(e => e.projectPath === 'PAM/pas-api')!
    expect(apiEvent.status).toBe('success')
  })

  it('partial failure: records failed event and returns fix_failed', async () => {
    const reportId = await seedReport({
      scopes: [
        { path: 'PAM/a', sourceBranch: 'master', isPrimary: true },
        { path: 'PAM/b', sourceBranch: 'master' },
      ],
      issueId: 300,
    })

    vi.mocked(runFixForProject)
      .mockResolvedValueOnce({ branch: 'fix/a', testPassed: true })
      .mockResolvedValueOnce({ branch: 'fix/b', testPassed: false, error: '测试未通过' })

    const result = await handleFixBug(makeOpts(reportId) as any, 'l2')

    expect(result.success).toBe(false)
    expect(result.error).toBe('fix_failed')

    const events = await findByReportCode(reportId, 'fix_attempt')
    expect(events).toHaveLength(2)
    const failed = events.filter(e => e.status === 'failed')
    expect(failed).toHaveLength(1)
    expect(failed[0].projectPath).toBe('PAM/b')
    expect((failed[0].data as Record<string, unknown>).error).toBe('测试未通过')
  })

  it('catches runFixForProject throw: records failed event with error message', async () => {
    const reportId = await seedReport({
      scopes: [{ path: 'PAM/a', sourceBranch: 'master', isPrimary: true }],
      issueId: 350,
    })

    vi.mocked(runFixForProject).mockRejectedValueOnce(new Error('worktree 挂了'))

    const result = await handleFixBug(makeOpts(reportId) as any, 'l2')

    expect(result.success).toBe(false)
    expect(result.error).toBe('fix_failed')
    const events = await findByReportCode(reportId, 'fix_attempt')
    expect(events).toHaveLength(1)
    expect(events[0].status).toBe('failed')
    expect((events[0].data as Record<string, unknown>).error).toBe('worktree 挂了')
  })

  it('no scope_identified: returns no_scope error', async () => {
    // seed report 但不写 scope_identified
    const productLineId = await seedProductLine()
    const report = await createBugAnalysisReport({
      issueId: 400,
      issueUrl: 'http://x',
      productLineId,
      agentSessionId: null,
      level: 'l2',
      classification: 'bug',
      confidence: 'medium',
      confidenceScore: 0.8,
      rootCauseSummary: '',
      solutionsJson: [],
      affectedModules: null,
      analysisSteps: null,
      metadata: null,
    })

    const result = await handleFixBug(makeOpts(report.id) as any, 'l2')

    expect(result.success).toBe(false)
    expect(result.error).toBe('no_scope')
    expect(runFixForProject).not.toHaveBeenCalled()
  })

  it('attempt field increments across retries', async () => {
    const reportId = await seedReport({
      scopes: [{ path: 'PAM/a', sourceBranch: 'master', isPrimary: true }],
      issueId: 500,
    })
    // 预置一条失败的 fix_attempt
    await createEvent({
      reportId,
      projectPath: 'PAM/a',
      code: 'fix_attempt',
      status: 'failed',
      data: { branch: 'fix/a-old', attempt: 1, error: '旧失败' },
    })

    vi.mocked(runFixForProject).mockResolvedValue({ branch: 'fix/a-new', testPassed: true })

    const result = await handleFixBug(makeOpts(reportId) as any, 'l2')

    expect(result.success).toBe(true)
    // 确认 attempt 传给 runFixForProject 时是 2
    expect(vi.mocked(runFixForProject).mock.calls[0][0].attempt).toBe(2)

    const events = await findByReportCode(reportId, 'fix_attempt')
    expect(events).toHaveLength(2)
    const newEvent = events.find(e => e.status === 'success')!
    expect((newEvent.data as Record<string, unknown>).attempt).toBe(2)
  })

  it('missing reportId → returns missing_reportId', async () => {
    const result = await handleFixBug(
      {
        capabilityKey: 'fix_bug_l2',
        context: {
          taskId: 't',
          groupId: 'g',
          platform: 'pipeline',
          initiatorId: 'p',
          initiatorRole: 'admin',
        },
        extraParams: {},
      } as any,
      'l2',
    )

    expect(result.success).toBe(false)
    expect(result.error).toBe('missing_reportId')
  })

  it('report not found → returns report_not_found', async () => {
    await resetTestDb()
    const result = await handleFixBug(makeOpts(999999) as any, 'l2')
    expect(result.success).toBe(false)
    expect(result.error).toBe('report_not_found')
  })

  // C4 回归保护：fix-runner 当前是按 project 串行 for 循环（peak concurrency=1），
  // 避免多 project 同时起 Claude CLI 爆机器/API。此测试断言行为未被误改为 Promise.all。
  it('multi-project 串行执行（peak concurrency=1，C4 回归保护）', async () => {
    const reportId = await seedReport({
      scopes: [
        { path: 'PAM/a', isPrimary: true },
        { path: 'PAM/b' },
        { path: 'PAM/c' },
        { path: 'PAM/d' },
      ],
      issueId: 400,
    })

    let active = 0
    let peak = 0
    vi.mocked(runFixForProject).mockImplementation(async (input) => {
      active++
      peak = Math.max(peak, active)
      await new Promise(res => setTimeout(res, 20))
      active--
      return { branch: `fix/issue-${input.issueId}`, testPassed: true }
    })

    const result = await handleFixBug(makeOpts(reportId) as any, 'l2')
    expect(result.success).toBe(true)
    expect(runFixForProject).toHaveBeenCalledTimes(4)
    // 串行执行：峰值并发恒为 1
    expect(peak).toBe(1)
  })
})
