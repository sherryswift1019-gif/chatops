import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resetTestDb, getTestPool } from '../helpers/db.js'
import { handleIssueEvent, handleMergeRequestEvent } from '../../adapters/gitlab/issue-handler.js'
import {
  createEvent,
  findByReportCode,
} from '../../db/repositories/bug-fix-events.js'
import {
  createBugAnalysisReport,
  getBugAnalysisReportById,
} from '../../db/repositories/bug-analysis-reports.js'

// Mock coordinator.triggerCapability：验证废除后的分支不再被调用
vi.mock('../../agent/coordinator.js', () => ({
  triggerCapability: vi.fn().mockResolvedValue({ success: true }),
}))
import { triggerCapability } from '../../agent/coordinator.js'

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

/** 构造一份 L2 report + create_mr 事件（MR 生命周期同步的前置条件） */
async function seedReportWithCreateMr(opts: {
  projectPath: string
  mrIid: number
  issueIid?: number
}): Promise<number> {
  const productLineId = await seedProductLine()
  const report = await createBugAnalysisReport({
    issueId: opts.issueIid ?? 100,
    issueUrl: `http://git.example.com/${opts.projectPath}/-/issues/${opts.issueIid ?? 100}`,
    productLineId,
    agentSessionId: null,
    level: 'l2',
    classification: 'bug',
    confidence: 'medium',
    confidenceScore: 0.8,
    rootCauseSummary: 'seed',
    solutionsJson: [{ id: 'a', summary: 's', recommended: true, risk: 'low', effort: 'small' }],
    affectedModules: null,
    analysisSteps: null,
    metadata: null,
    primaryProjectPath: opts.projectPath,
  })
  await createEvent({
    reportId: report.id,
    projectPath: opts.projectPath,
    code: 'create_mr',
    status: 'success',
    data: { mrIid: opts.mrIid, mrUrl: `http://mr/${opts.mrIid}`, branch: 'fix/x', isPrimary: true },
  })
  return report.id
}

describe('issue-handler webhook (refactored)', () => {
  beforeEach(async () => {
    await resetTestDb()
    vi.mocked(triggerCapability).mockClear()
  })

  it('MR merged → updates bug_analysis_reports.status=completed + writes lifecycle_sync', async () => {
    const reportId = await seedReportWithCreateMr({ projectPath: 'PAM/pas-6.0', mrIid: 55 })

    await handleMergeRequestEvent({
      object_kind: 'merge_request',
      object_attributes: {
        iid: 55, title: 't', action: 'merge',
        source_branch: 'fix/x', target_branch: 'test',
      },
      project: { path_with_namespace: 'PAM/pas-6.0' },
    } as any)

    const report = await getBugAnalysisReportById(reportId)
    expect(report?.status).toBe('completed')

    const syncEvents = await findByReportCode(reportId, 'lifecycle_sync')
    expect(syncEvents).toHaveLength(1)
    expect((syncEvents[0].data as any).mrAction).toBe('merge')
    expect((syncEvents[0].data as any).targetStatus).toBe('completed')
    expect((syncEvents[0].data as any).mrIid).toBe(55)
  })

  it('MR closed (not merged) → updates to aborted', async () => {
    const reportId = await seedReportWithCreateMr({ projectPath: 'PAM/pas-6.0', mrIid: 55 })

    await handleMergeRequestEvent({
      object_kind: 'merge_request',
      object_attributes: {
        iid: 55, title: 't', action: 'close',
        source_branch: 'fix/x', target_branch: 'test',
      },
      project: { path_with_namespace: 'PAM/pas-6.0' },
    } as any)

    const report = await getBugAnalysisReportById(reportId)
    expect(report?.status).toBe('aborted')

    const syncEvents = await findByReportCode(reportId, 'lifecycle_sync')
    expect(syncEvents).toHaveLength(1)
    expect((syncEvents[0].data as any).mrAction).toBe('close')
    expect((syncEvents[0].data as any).targetStatus).toBe('aborted')
  })

  it('MR open/update: no status change, no capability dispatch', async () => {
    const reportId = await seedReportWithCreateMr({ projectPath: 'PAM/pas-6.0', mrIid: 55 })
    const before = await getBugAnalysisReportById(reportId)

    await handleMergeRequestEvent({
      object_kind: 'merge_request',
      object_attributes: {
        iid: 55, title: 't', action: 'open',
        source_branch: 'fix/x', target_branch: 'test',
        labels: [{ title: 'ai-generated' }],
      },
      project: { path_with_namespace: 'PAM/pas-6.0' },
    } as any)

    expect(triggerCapability).not.toHaveBeenCalled()
    const after = await getBugAnalysisReportById(reportId)
    expect(after?.status).toBe(before?.status)
    expect(after?.status).not.toBe('completed')
    expect(after?.status).not.toBe('aborted')
    const syncEvents = await findByReportCode(reportId, 'lifecycle_sync')
    expect(syncEvents).toHaveLength(0)
  })

  it('idempotent: MR merged twice does not duplicate lifecycle_sync', async () => {
    const reportId = await seedReportWithCreateMr({ projectPath: 'PAM/pas-6.0', mrIid: 55 })
    const payload = {
      object_kind: 'merge_request',
      object_attributes: {
        iid: 55, title: 't', action: 'merge',
        source_branch: 'fix/x', target_branch: 'test',
      },
      project: { path_with_namespace: 'PAM/pas-6.0' },
    }

    await handleMergeRequestEvent(payload as any)
    await handleMergeRequestEvent(payload as any)

    const events = await findByReportCode(reportId, 'lifecycle_sync')
    expect(events).toHaveLength(1)
  })

  it('MR not related to any report: no-op', async () => {
    await seedReportWithCreateMr({ projectPath: 'PAM/pas-6.0', mrIid: 55 })

    await handleMergeRequestEvent({
      object_kind: 'merge_request',
      object_attributes: {
        iid: 99999, title: 't', action: 'merge',
        source_branch: 'fix/x', target_branch: 'test',
      },
      project: { path_with_namespace: 'OTHER/repo' },
    } as any)

    // 不抛错，不写事件，不更新 status —— 直接验证原 report 未被改动即可
    const pool = getTestPool()
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS c FROM bug_fix_events WHERE code = 'lifecycle_sync'`)
    expect(rows[0].c).toBe(0)
  })

  it('Issue webhook with approved label: ignored (old dispatch removed)', async () => {
    await handleIssueEvent({
      object_kind: 'issue',
      object_attributes: {
        iid: 100, title: 'Bug', action: 'update',
        labels: [{ title: 'approved' }],
      },
      project: { path_with_namespace: 'PAM/pas-6.0' },
      changes: {
        labels: {
          previous: [{ title: 'needs-approval' }],
          current: [{ title: 'approved' }],
        },
      },
    } as any)

    expect(triggerCapability).not.toHaveBeenCalled()
  })
})
