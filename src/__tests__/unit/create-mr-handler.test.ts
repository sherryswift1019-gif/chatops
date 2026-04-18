import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resetTestDb, getTestPool } from '../helpers/db.js'
import { handleCreateMr } from '../../agent/mr/mr-handler.js'
import {
  createEvent,
  findByReportCode,
} from '../../db/repositories/bug-fix-events.js'
import { createBugAnalysisReport } from '../../db/repositories/bug-analysis-reports.js'

vi.mock('../../agent/mr/gitlab-mr.js', () => ({
  gitlabCreateMr: vi.fn(),
}))
import { gitlabCreateMr } from '../../agent/mr/gitlab-mr.js'

interface ProjectSeed {
  path: string
  isPrimary: boolean
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

/**
 * 构造一份 L2 已修复状态的 report：
 *   - 每个 project 都写 scope_identified + fix_attempt(success) 事件
 *   - 主仓库写 create_issue(isPrimary=true, issueIid=mainIssueIid)
 */
async function seedL2Report(opts: {
  projects: ProjectSeed[]
  mainIssueIid: number
  /** 覆盖默认的 fix_attempt 状态：默认全部 success。 */
  fixStatusByProject?: Record<string, 'success' | 'failed'>
  /** 不写 create_issue 事件（用于 no_primary_issue 场景）。 */
  skipCreateIssue?: boolean
}): Promise<number> {
  const productLineId = await seedProductLine()
  const primary = opts.projects.find(p => p.isPrimary) ?? opts.projects[0]

  const report = await createBugAnalysisReport({
    issueId: opts.mainIssueIid,
    issueUrl: `http://git.example.com/${primary.path}/-/issues/${opts.mainIssueIid}`,
    productLineId,
    agentSessionId: null,
    level: 'l2',
    classification: 'bug',
    confidence: 'medium',
    confidenceScore: 0.8,
    rootCauseSummary: 'token 签发模块缺少过期校验，引发跨服务鉴权异常',
    solutionsJson: [
      { id: 'a', summary: '增加过期校验', recommended: true, risk: 'low', effort: 'small' },
    ],
    affectedModules: ['auth'],
    analysisSteps: null,
    metadata: null,
    primaryProjectPath: primary.path,
  })

  for (const p of opts.projects) {
    await createEvent({
      reportId: report.id,
      projectPath: p.path,
      code: 'scope_identified',
      data: { isPrimary: p.isPrimary, sourceBranch: 'test' },
    })
    const status = opts.fixStatusByProject?.[p.path] ?? 'success'
    await createEvent({
      reportId: report.id,
      projectPath: p.path,
      code: 'fix_attempt',
      status,
      data: { branch: `fix/issue-${opts.mainIssueIid}-a1`, targetBranch: 'test', isPrimary: p.isPrimary },
    })
  }

  if (!opts.skipCreateIssue) {
    await createEvent({
      reportId: report.id,
      projectPath: primary.path,
      code: 'create_issue',
      data: { issueIid: opts.mainIssueIid, issueUrl: report.issueUrl, isPrimary: true, isReused: false },
    })
  }

  return report.id
}

describe('create_mr handler', () => {
  beforeEach(async () => {
    await resetTestDb()
    vi.mocked(gitlabCreateMr).mockReset()
  })

  it('creates MR for each project with fix_attempt success', async () => {
    const reportId = await seedL2Report({
      projects: [{ path: 'PAM/pas-api', isPrimary: true }],
      mainIssueIid: 100,
    })
    vi.mocked(gitlabCreateMr).mockResolvedValue({ iid: 55, url: 'http://mr/55' })

    const result = await handleCreateMr({
      capabilityKey: 'create_mr',
      context: { taskId: 't', groupId: 'g', platform: 'pipeline', initiatorId: 'p', initiatorRole: 'admin' },
      extraParams: { reportId },
    })

    expect(result.success).toBe(true)
    expect(gitlabCreateMr).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: 'PAM/pas-api',
        sourceBranch: 'fix/issue-100-a1',
        targetBranch: 'test',
        description: expect.stringContaining('Closes #100'),
      }),
    )

    const events = await findByReportCode(reportId, 'create_mr')
    expect(events).toHaveLength(1)
    expect((events[0].data as Record<string, unknown>).mrIid).toBe(55)
    expect((events[0].data as Record<string, unknown>).mrUrl).toBe('http://mr/55')
    expect((events[0].data as Record<string, unknown>).branch).toBe('fix/issue-100-a1')
    expect((events[0].data as Record<string, unknown>).isPrimary).toBe(true)
  })

  it('multi-project: primary uses Closes, secondary uses Related to', async () => {
    const reportId = await seedL2Report({
      projects: [
        { path: 'PAM/pas-6.0', isPrimary: true },
        { path: 'PAM/pas-api', isPrimary: false },
      ],
      mainIssueIid: 100,
    })
    vi.mocked(gitlabCreateMr).mockResolvedValue({ iid: 1, url: 'x' })

    await handleCreateMr({
      capabilityKey: 'create_mr',
      context: { taskId: 't', groupId: 'g', platform: 'pipeline', initiatorId: 'p', initiatorRole: 'admin' },
      extraParams: { reportId },
    })

    const calls = vi.mocked(gitlabCreateMr).mock.calls
    const primary = calls.find(c => c[0].projectPath === 'PAM/pas-6.0')
    const secondary = calls.find(c => c[0].projectPath === 'PAM/pas-api')
    expect(primary).toBeTruthy()
    expect(secondary).toBeTruthy()
    const primaryDesc = primary![0].description as string
    const secondaryDesc = secondary![0].description as string
    expect(primaryDesc).toContain('Closes #100')
    expect(primaryDesc).not.toContain('Related to')
    expect(secondaryDesc).toContain('Related to PAM/pas-6.0#100')
    expect(secondaryDesc).not.toMatch(/Closes #\d/)
  })

  it('multi-project adds coordination warning in description', async () => {
    const reportId = await seedL2Report({
      projects: [
        { path: 'PAM/a', isPrimary: true },
        { path: 'PAM/b', isPrimary: false },
      ],
      mainIssueIid: 100,
    })
    vi.mocked(gitlabCreateMr).mockResolvedValue({ iid: 1, url: 'x' })

    await handleCreateMr({
      capabilityKey: 'create_mr',
      context: { taskId: 't', groupId: 'g', platform: 'pipeline', initiatorId: 'p', initiatorRole: 'admin' },
      extraParams: { reportId },
    })

    const descriptions = vi.mocked(gitlabCreateMr).mock.calls.map(c => c[0].description)
    expect(descriptions).toHaveLength(2)
    for (const d of descriptions) {
      expect(d).toContain('此修复涉及 2 个服务')
      expect(d).toContain('请优先合并主仓库 MR')
    }
  })

  it('single-project: no coordination warning', async () => {
    const reportId = await seedL2Report({
      projects: [{ path: 'PAM/pas-api', isPrimary: true }],
      mainIssueIid: 200,
    })
    vi.mocked(gitlabCreateMr).mockResolvedValue({ iid: 9, url: 'http://mr/9' })

    await handleCreateMr({
      capabilityKey: 'create_mr',
      context: { taskId: 't', groupId: 'g', platform: 'pipeline', initiatorId: 'p', initiatorRole: 'admin' },
      extraParams: { reportId },
    })

    const desc = vi.mocked(gitlabCreateMr).mock.calls[0][0].description
    expect(desc).not.toContain('此修复涉及')
    expect(desc).toContain('Closes #200')
  })

  it('idempotent: skips projects with existing create_mr success event', async () => {
    const reportId = await seedL2Report({
      projects: [{ path: 'PAM/pas-api', isPrimary: true }],
      mainIssueIid: 300,
    })
    await createEvent({
      reportId,
      projectPath: 'PAM/pas-api',
      code: 'create_mr',
      status: 'success',
      data: { mrIid: 99, mrUrl: 'http://mr/99', branch: 'fix/issue-300-a1', isPrimary: true },
    })

    const result = await handleCreateMr({
      capabilityKey: 'create_mr',
      context: { taskId: 't', groupId: 'g', platform: 'pipeline', initiatorId: 'p', initiatorRole: 'admin' },
      extraParams: { reportId },
    })

    expect(result.success).toBe(true)
    expect(gitlabCreateMr).not.toHaveBeenCalled()
    const events = await findByReportCode(reportId, 'create_mr')
    expect(events).toHaveLength(1)
  })

  it('partial failure: records failed event and returns gitlab_api_error', async () => {
    const reportId = await seedL2Report({
      projects: [
        { path: 'PAM/a', isPrimary: true },
        { path: 'PAM/b', isPrimary: false },
      ],
      mainIssueIid: 400,
    })
    vi.mocked(gitlabCreateMr)
      .mockResolvedValueOnce({ iid: 1, url: 'http://mr/1' })
      .mockRejectedValueOnce(new Error('GitLab 500'))

    const result = await handleCreateMr({
      capabilityKey: 'create_mr',
      context: { taskId: 't', groupId: 'g', platform: 'pipeline', initiatorId: 'p', initiatorRole: 'admin' },
      extraParams: { reportId },
    })

    expect(result.success).toBe(false)
    expect(result.error).toBe('gitlab_api_error')
    const events = await findByReportCode(reportId, 'create_mr')
    expect(events).toHaveLength(2)
    const failed = events.filter(e => e.status === 'failed')
    expect(failed).toHaveLength(1)
  })

  it('no fix_attempt success → returns no_successful_fixes', async () => {
    const reportId = await seedL2Report({
      projects: [{ path: 'PAM/pas-api', isPrimary: true }],
      mainIssueIid: 500,
      fixStatusByProject: { 'PAM/pas-api': 'failed' },
    })

    const result = await handleCreateMr({
      capabilityKey: 'create_mr',
      context: { taskId: 't', groupId: 'g', platform: 'pipeline', initiatorId: 'p', initiatorRole: 'admin' },
      extraParams: { reportId },
    })

    expect(result.success).toBe(false)
    expect(result.error).toBe('no_successful_fixes')
    expect(gitlabCreateMr).not.toHaveBeenCalled()
  })

  it('no primary create_issue event → returns no_primary_issue', async () => {
    const reportId = await seedL2Report({
      projects: [{ path: 'PAM/pas-api', isPrimary: true }],
      mainIssueIid: 600,
      skipCreateIssue: true,
    })

    const result = await handleCreateMr({
      capabilityKey: 'create_mr',
      context: { taskId: 't', groupId: 'g', platform: 'pipeline', initiatorId: 'p', initiatorRole: 'admin' },
      extraParams: { reportId },
    })

    expect(result.success).toBe(false)
    expect(result.error).toBe('no_primary_issue')
  })

  it('missing reportId → returns missing_reportId', async () => {
    const result = await handleCreateMr({
      capabilityKey: 'create_mr',
      context: { taskId: 't', groupId: 'g', platform: 'pipeline', initiatorId: 'p', initiatorRole: 'admin' },
      extraParams: {},
    })
    expect(result.success).toBe(false)
    expect(result.error).toBe('missing_reportId')
  })

  it('report not found → returns report_not_found', async () => {
    const result = await handleCreateMr({
      capabilityKey: 'create_mr',
      context: { taskId: 't', groupId: 'g', platform: 'pipeline', initiatorId: 'p', initiatorRole: 'admin' },
      extraParams: { reportId: 999999 },
    })
    expect(result.success).toBe(false)
    expect(result.error).toBe('report_not_found')
  })

  it('skips project whose fix_attempt is not success even if earlier attempt succeeded', async () => {
    // 模拟同一 project 先 success 再 failed（最新的是 failed）
    const reportId = await seedL2Report({
      projects: [{ path: 'PAM/pas-api', isPrimary: true }],
      mainIssueIid: 700,
    })
    // 追加一次失败 fix_attempt（最新）
    await createEvent({
      reportId,
      projectPath: 'PAM/pas-api',
      code: 'fix_attempt',
      status: 'failed',
      data: { branch: 'fix/issue-700-a2', targetBranch: 'test', isPrimary: true },
    })

    const result = await handleCreateMr({
      capabilityKey: 'create_mr',
      context: { taskId: 't', groupId: 'g', platform: 'pipeline', initiatorId: 'p', initiatorRole: 'admin' },
      extraParams: { reportId },
    })

    expect(result.success).toBe(false)
    expect(result.error).toBe('no_successful_fixes')
    expect(gitlabCreateMr).not.toHaveBeenCalled()
  })
})
