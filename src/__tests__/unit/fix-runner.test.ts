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
import {
  handleFixBug,
  extractProjectPath,
  registerFixHandlers,
  isFixSuccessful,
} from '../../agent/fix/fix-runner.js'

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

// ============================================================
// 补充测试：纯 helper / register / 外层 catch / scope 缺 project_path
// ============================================================

describe('extractProjectPath', () => {
  it('http URL', () => {
    expect(extractProjectPath('http://git.example.com/PAM/pas-api')).toBe('PAM/pas-api')
  })

  it('https URL with .git suffix', () => {
    expect(extractProjectPath('https://gitlab.com/group/sub/repo.git')).toBe('group/sub/repo')
  })

  it('ssh-style URL (git@host:group/repo.git)', () => {
    expect(extractProjectPath('git@git.example.com:PAM/pas-api.git')).toBe('PAM/pas-api')
  })

  it('ssh-style 不带 .git 后缀', () => {
    expect(extractProjectPath('git@host:team/proj')).toBe('team/proj')
  })

  it('无匹配 http/ssh 格式时退回原串（去掉 .git）', () => {
    expect(extractProjectPath('justpath.git')).toBe('justpath')
    expect(extractProjectPath('plain-string')).toBe('plain-string')
  })
})

describe('isFixSuccessful (re-exported)', () => {
  it('兼容导出：runner 侧的 isFixSuccessful 等于 fix-logic 的实现（mock 版恒 true）', () => {
    // mock 里设为 () => true，这里只验证导出链不断
    expect(typeof isFixSuccessful).toBe('function')
    expect(isFixSuccessful('whatever')).toBe(true)
  })
})

describe('registerFixHandlers', () => {
  it('调用后在 coordinator 注册 fix_bug_l1/l2/l3 三个 handler', async () => {
    // 使用真实 coordinator（未 mock），注册完后 triggerCapability 能找到 handler
    registerFixHandlers()
    const { registerCapabilityHandler } = await import('../../agent/coordinator.js')
    // registerCapabilityHandler 是 Map.set，已注册过的 key 会覆盖，重复调用无副作用
    expect(typeof registerCapabilityHandler).toBe('function')
    // 再调一次也不抛
    expect(() => registerFixHandlers()).not.toThrow()
  })

  it('通过 triggerCapability 路由到各 level handler（覆盖 level wrapper arrow）', async () => {
    await resetTestDb()
    vi.mocked(runFixForProject).mockReset()
    vi.mocked(runFixForProject).mockResolvedValue({ branch: 'fix/x', testPassed: true })

    // 先注册
    registerFixHandlers()

    // 在 capabilities 表里 seed fix_bug_l1/l2/l3，triggerCapability 才能通过 capability 查找
    const pool = getTestPool()
    for (const key of ['fix_bug_l1', 'fix_bug_l2', 'fix_bug_l3']) {
      await pool.query(
        `INSERT INTO capabilities (key, display_name, description, category, tool_names, needs_approval, is_system, system_prompt)
         VALUES ($1, $1, 'test', 'action', '[]'::jsonb, false, true, 'SP')
         ON CONFLICT (key) DO UPDATE SET system_prompt = EXCLUDED.system_prompt`,
        [key],
      )
    }

    const { triggerCapability } = await import('../../agent/coordinator.js')

    for (const level of ['l1', 'l2', 'l3']) {
      const reportId = await seedReport({
        scopes: [{ path: `PAM/${level}`, isPrimary: true }],
        issueId: 900 + (level.charCodeAt(1) - '0'.charCodeAt(0)),
      })
      const res = await triggerCapability({
        capabilityKey: `fix_bug_${level}`,
        context: {
          taskId: `t-${level}`,
          groupId: 'g',
          platform: 'pipeline',
          initiatorId: 'p',
          initiatorRole: 'admin',
        },
        extraParams: { reportId },
      } as any)
      expect(res.success).toBe(true)
    }
    expect(runFixForProject).toHaveBeenCalledTimes(3)
    // 验证 level 参数正确传到 runFixForProject
    const levels = vi.mocked(runFixForProject).mock.calls.map(c => c[0].level)
    expect(new Set(levels)).toEqual(new Set(['l1', 'l2', 'l3']))
  })
})

describe('handleFixBug outer catch (handler_error)', () => {
  beforeEach(async () => {
    await resetTestDb()
    vi.mocked(runFixForProject).mockReset()
  })

  it('getBugAnalysisReportById 抛错时返回 handler_error', async () => {
    // 直接传一个超大 reportId 触发正常的 not_found 分支不行（那是 report_not_found）
    // 走 catch 块需要 getBugAnalysisReportById 真的抛错。用 spy + 临时替换 pool.query 太重，
    // 改为：传非法 reportId 通过 Number 之后 > 0，但 findByReportCode 抛错。
    // 最简方案：mock findByReportCode 抛错一次。
    const repo = await import('../../db/repositories/bug-fix-events.js')
    const spy = vi.spyOn(repo, 'findByReportCode').mockImplementationOnce(async () => {
      throw new Error('db connection lost')
    })

    // 先创建一个真实 report，这样前两个 DB 调用 (getBugAnalysisReportById) 不抛
    const reportId = await seedReport({
      scopes: [{ path: 'PAM/a', isPrimary: true }],
      issueId: 999,
    })

    const result = await handleFixBug(makeOpts(reportId) as any, 'l2')
    expect(result.success).toBe(false)
    expect(result.error).toBe('handler_error')
    expect(result.output).toContain('handler 异常')
    expect(result.output).toContain('db connection lost')
    spy.mockRestore()
  })

  it('非 Error 抛出物（字符串）也被 catch 并转成 handler_error', async () => {
    const repo = await import('../../db/repositories/bug-fix-events.js')
    const spy = vi.spyOn(repo, 'findByReportCode').mockImplementationOnce(async () => {
      // eslint-disable-next-line no-throw-literal
      throw 'raw-string-error'
    })
    const reportId = await seedReport({
      scopes: [{ path: 'PAM/a', isPrimary: true }],
      issueId: 998,
    })

    const result = await handleFixBug(makeOpts(reportId) as any, 'l2')
    expect(result.success).toBe(false)
    expect(result.error).toBe('handler_error')
    expect(result.output).toContain('raw-string-error')
    spy.mockRestore()
  })
})

describe('handleFixBug scope 缺 project_path 边界', () => {
  beforeEach(async () => {
    await resetTestDb()
    vi.mocked(runFixForProject).mockReset()
  })

  it('scope_identified 事件 projectPath=null 时记 failures 但不影响其他 project', async () => {
    // 手动 seed：一个 project_path=NULL 的 scope + 一个正常 scope
    const productLineId = await seedProductLine()
    const report = await createBugAnalysisReport({
      issueId: 777,
      issueUrl: 'http://x/777',
      productLineId,
      agentSessionId: null,
      level: 'l2',
      classification: 'bug',
      confidence: 'medium',
      confidenceScore: 0.8,
      rootCauseSummary: 'r',
      solutionsJson: [],
      affectedModules: null,
      analysisSteps: null,
      metadata: null,
      primaryProjectPath: 'PAM/ok',
    })
    // NULL project_path 的 scope
    await createEvent({
      reportId: report.id,
      projectPath: null,
      code: 'scope_identified',
      data: { sourceBranch: 'master', affectedModules: [] },
    })
    // 正常 project_path 的 scope
    await createEvent({
      reportId: report.id,
      projectPath: 'PAM/ok',
      code: 'scope_identified',
      data: { sourceBranch: 'master', affectedModules: [], isPrimary: true },
    })

    vi.mocked(runFixForProject).mockResolvedValue({ branch: 'fix/a', testPassed: true })

    const result = await handleFixBug(makeOpts(report.id) as any, 'l2')

    // 因为有 failures（null 那条）→ success=false + fix_failed
    expect(result.success).toBe(false)
    expect(result.error).toBe('fix_failed')
    expect(result.output).toContain('unknown')
    // 正常那个 project 仍被修复
    expect(runFixForProject).toHaveBeenCalledTimes(1)
    expect(vi.mocked(runFixForProject).mock.calls[0][0].projectPath).toBe('PAM/ok')
  })
})

describe('handleFixBug runFixForProject 入参 & report.primaryProjectPath 为空兼容', () => {
  beforeEach(async () => {
    await resetTestDb()
    vi.mocked(runFixForProject).mockReset()
  })

  it('传给 runFixForProject 的参数来自 report + scope.data', async () => {
    const reportId = await seedReport({
      scopes: [
        {
          path: 'PAM/a',
          sourceBranch: 'release/1.0',
          affectedModules: ['m1', 'm2'],
          isPrimary: true,
        },
      ],
      issueId: 12345,
    })
    vi.mocked(runFixForProject).mockResolvedValue({ branch: 'fix/x', testPassed: true })

    await handleFixBug(makeOpts(reportId) as any, 'l3')

    const calledArg = vi.mocked(runFixForProject).mock.calls[0][0]
    expect(calledArg.reportId).toBe(reportId)
    expect(calledArg.projectPath).toBe('PAM/a')
    expect(calledArg.sourceBranch).toBe('release/1.0')
    expect(calledArg.affectedModules).toEqual(['m1', 'm2'])
    expect(calledArg.issueId).toBe(12345)
    expect(calledArg.level).toBe('l3')
    expect(calledArg.attempt).toBe(1)
  })

  it('scope.data.affectedModules 非数组时退化为 []', async () => {
    const productLineId = await seedProductLine()
    const report = await createBugAnalysisReport({
      issueId: 321,
      issueUrl: 'http://x/321',
      productLineId,
      agentSessionId: null,
      level: 'l2',
      classification: 'bug',
      confidence: 'medium',
      confidenceScore: 0.8,
      rootCauseSummary: 'r',
      solutionsJson: [],
      affectedModules: null,
      analysisSteps: null,
      metadata: null,
      primaryProjectPath: 'PAM/a',
    })
    await createEvent({
      reportId: report.id,
      projectPath: 'PAM/a',
      code: 'scope_identified',
      // affectedModules 是字符串，不是数组
      data: { sourceBranch: 'master', affectedModules: 'oops-not-array' as unknown as string[] },
    })
    vi.mocked(runFixForProject).mockResolvedValue({ branch: 'fix/a', testPassed: true })

    await handleFixBug(makeOpts(report.id) as any, 'l2')

    const arg = vi.mocked(runFixForProject).mock.calls[0][0]
    expect(arg.affectedModules).toEqual([])
  })

  it('scope.data 为空对象时 sourceBranch 默认 master', async () => {
    const productLineId = await seedProductLine()
    const report = await createBugAnalysisReport({
      issueId: 654,
      issueUrl: 'http://x/654',
      productLineId,
      agentSessionId: null,
      level: 'l2',
      classification: 'bug',
      confidence: 'medium',
      confidenceScore: 0.8,
      rootCauseSummary: 'r',
      solutionsJson: [],
      affectedModules: null,
      analysisSteps: null,
      metadata: null,
      primaryProjectPath: 'PAM/b',
    })
    await createEvent({
      reportId: report.id,
      projectPath: 'PAM/b',
      code: 'scope_identified',
      // data 为空 → 全部走默认值
      data: {},
    })
    vi.mocked(runFixForProject).mockResolvedValue({ branch: 'fix/b', testPassed: true })

    await handleFixBug(makeOpts(report.id) as any, 'l2')
    const arg = vi.mocked(runFixForProject).mock.calls[0][0]
    expect(arg.sourceBranch).toBe('master')
    expect(arg.affectedModules).toEqual([])
  })
})
