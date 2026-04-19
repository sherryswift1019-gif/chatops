/**
 * Unit test: request_handover handler
 *
 * 覆盖：
 * - 错误路径：missing reportId / missing reason / invalid reason / report 不存在
 * - 正常路径：fix_exhausted / l4_manual / user_requested 三个 MVP reason
 * - 幂等：已有 handover success 事件 → 跳过
 * - 状态转移：report.status → 'pending_manual'
 * - 事件写入：bug_fix_events(code='handover') 含 V2 data 结构字段
 * - scope_identified 收集 → data.projectPaths
 * - context 可选字段（failedStage / comment / attemptCount）传递
 * - GitLab label 失败降级（gitlabAddIssueLabel throw 时主流程仍 success）
 * - V2 预留 reason（revise_exhausted 等）处理不报错
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resetTestDb, getTestPool } from '../helpers/db.js'
import {
  createEvent,
  findByReportCode,
} from '../../db/repositories/bug-fix-events.js'
import {
  createBugAnalysisReport,
  getBugAnalysisReportById,
} from '../../db/repositories/bug-analysis-reports.js'

// mock gitlab-label，避免真实调 GitLab API
vi.mock('../../agent/handover/gitlab-label.js', () => ({
  gitlabAddIssueLabel: vi.fn().mockResolvedValue(undefined),
}))
import { gitlabAddIssueLabel } from '../../agent/handover/gitlab-label.js'
import { handleRequestHandover } from '../../agent/handover/request-handover-handler.js'

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

async function seedReport(opts?: {
  issueId?: number
  projectPath?: string
  scopes?: string[]
}): Promise<number> {
  const productLineId = await seedProductLine()
  const issueId = opts?.issueId ?? 777
  const projectPath = opts?.projectPath ?? 'PAM/pas-6.0'
  const report = await createBugAnalysisReport({
    issueId,
    issueUrl: `http://git.example.com/${projectPath}/-/issues/${issueId}`,
    productLineId,
    agentSessionId: null,
    level: 'l2',
    classification: 'bug',
    confidence: 'medium',
    confidenceScore: 0.7,
    rootCauseSummary: 'test root cause',
    solutionsJson: [{ id: 'a', summary: 's', recommended: true, risk: 'low', effort: 'small' }],
    affectedModules: null,
    analysisSteps: null,
    metadata: null,
    primaryProjectPath: projectPath,
  })

  for (const s of opts?.scopes ?? [projectPath]) {
    await createEvent({
      reportId: report.id,
      projectPath: s,
      code: 'scope_identified',
      data: { sourceBranch: 'master', affectedModules: [], isPrimary: s === projectPath },
    })
  }

  return report.id
}

function makeOpts(
  reportId: number | null,
  reason: string | undefined,
  context?: Record<string, unknown>,
) {
  return {
    capabilityKey: 'request_handover',
    context: {
      taskId: 't',
      groupId: 'g',
      platform: 'api',
      initiatorId: 'u1',
      initiatorRole: 'admin',
    },
    extraParams: {
      ...(reportId !== null ? { reportId } : {}),
      ...(reason !== undefined ? { reason } : {}),
      ...(context ? { context } : {}),
    },
  } as any
}

describe('request_handover handler', () => {
  beforeEach(async () => {
    await resetTestDb()
    vi.mocked(gitlabAddIssueLabel).mockReset()
    vi.mocked(gitlabAddIssueLabel).mockResolvedValue(undefined)
  })

  describe('参数校验', () => {
    it('missing reportId → missing_reportId', async () => {
      const result = await handleRequestHandover(makeOpts(null, 'fix_exhausted'))
      expect(result.success).toBe(false)
      expect(result.error).toBe('missing_reportId')
    })

    it('missing reason → missing_reason', async () => {
      const reportId = await seedReport()
      const result = await handleRequestHandover(makeOpts(reportId, undefined))
      expect(result.success).toBe(false)
      expect(result.error).toBe('missing_reason')
    })

    it('invalid reason → invalid_reason', async () => {
      const reportId = await seedReport()
      const result = await handleRequestHandover(makeOpts(reportId, 'bogus_reason'))
      expect(result.success).toBe(false)
      expect(result.error).toBe('invalid_reason')
    })

    it('report 不存在 → report_not_found', async () => {
      const result = await handleRequestHandover(makeOpts(999999, 'fix_exhausted'))
      expect(result.success).toBe(false)
      expect(result.error).toBe('report_not_found')
    })
  })

  describe('MVP 3 个 reason 全部正常处理', () => {
    it.each([
      ['fix_exhausted'],
      ['l4_manual'],
      ['user_requested'],
    ])('reason=%s → 写 handover 事件 + status=pending_manual', async reason => {
      const reportId = await seedReport()

      const result = await handleRequestHandover(makeOpts(reportId, reason))

      expect(result.success).toBe(true)
      expect(result.output).toContain('handover requested')

      // 事件写入
      const events = await findByReportCode(reportId, 'handover')
      expect(events).toHaveLength(1)
      expect(events[0].status).toBe('success')
      const data = events[0].data as Record<string, unknown>
      expect(data.reason).toBe(reason)
      expect(data.fixBranch).toBe('fix/issue-777')
      expect(data.nextAction).toBe('await_owner')

      // 状态转移
      const report = await getBugAnalysisReportById(reportId)
      expect(report?.status).toBe('pending_manual')

      // GitLab label 调用
      expect(gitlabAddIssueLabel).toHaveBeenCalledWith('PAM/pas-6.0', 777, 'needs-manual')
    })
  })

  describe('幂等保护', () => {
    it('已有 handover success 事件 → 跳过，不重复写入', async () => {
      const reportId = await seedReport()
      await createEvent({
        reportId,
        projectPath: null,
        code: 'handover',
        status: 'success',
        data: { reason: 'fix_exhausted', projectPaths: ['PAM/pas-6.0'] },
      })

      const result = await handleRequestHandover(makeOpts(reportId, 'user_requested'))

      expect(result.success).toBe(true)
      expect(result.output).toContain('already handed over')
      const events = await findByReportCode(reportId, 'handover')
      expect(events).toHaveLength(1)  // 不新增
      expect(gitlabAddIssueLabel).not.toHaveBeenCalled()  // label 也不重打
    })
  })

  describe('scope_identified 收集', () => {
    it('多 project 场景 → data.projectPaths 含全部去重后的 path', async () => {
      const reportId = await seedReport({
        projectPath: 'PAM/pas-6.0',
        scopes: ['PAM/pas-6.0', 'PAM/pas-api', 'PAM/pas-api'],  // 含重复
      })

      const result = await handleRequestHandover(makeOpts(reportId, 'fix_exhausted'))

      expect(result.success).toBe(true)
      const events = await findByReportCode(reportId, 'handover')
      const data = events[0].data as Record<string, unknown>
      expect(new Set(data.projectPaths as string[])).toEqual(
        new Set(['PAM/pas-6.0', 'PAM/pas-api']),
      )
    })
  })

  describe('context 可选字段', () => {
    it('传入 failedStage/comment/attemptCount → 写入 data', async () => {
      const reportId = await seedReport()

      const result = await handleRequestHandover(
        makeOpts(reportId, 'fix_exhausted', {
          failedStage: 'fix_bug_l2',
          comment: '测试打回',
          attemptCount: 3,
        }),
      )

      expect(result.success).toBe(true)
      const events = await findByReportCode(reportId, 'handover')
      const data = events[0].data as Record<string, unknown>
      expect(data.failedAt).toBe('fix_bug_l2')
      expect(data.comment).toBe('测试打回')
      expect(data.attemptCount).toBe(3)
    })

    it('未传 context → 对应字段为 null', async () => {
      const reportId = await seedReport()

      await handleRequestHandover(makeOpts(reportId, 'l4_manual'))

      const events = await findByReportCode(reportId, 'handover')
      const data = events[0].data as Record<string, unknown>
      expect(data.failedAt).toBeNull()
      expect(data.comment).toBeNull()
      expect(data.attemptCount).toBeNull()
    })
  })

  describe('GitLab label 失败降级', () => {
    it('gitlabAddIssueLabel throw → 主流程仍 success，data.labelAdded=false + labelError', async () => {
      vi.mocked(gitlabAddIssueLabel).mockRejectedValueOnce(new Error('GitLab 500'))
      const reportId = await seedReport()

      const result = await handleRequestHandover(makeOpts(reportId, 'fix_exhausted'))

      expect(result.success).toBe(true)  // 不阻断
      const events = await findByReportCode(reportId, 'handover')
      const data = events[0].data as Record<string, unknown>
      expect(data.labelAdded).toBe(false)
      expect(data.labelError).toContain('GitLab 500')

      const report = await getBugAnalysisReportById(reportId)
      expect(report?.status).toBe('pending_manual')
    })
  })

  describe('V2 预留 reason', () => {
    it.each([
      ['revise_exhausted'],
      ['low_confidence'],
      ['owner_label'],
      ['tag_unrevisable'],
    ])('reason=%s (V2-only) → handler 不报错，照常写事件', async reason => {
      const reportId = await seedReport()

      const result = await handleRequestHandover(makeOpts(reportId, reason))

      expect(result.success).toBe(true)
      const events = await findByReportCode(reportId, 'handover')
      expect(events[0].data as any).toMatchObject({ reason })
    })
  })
})
