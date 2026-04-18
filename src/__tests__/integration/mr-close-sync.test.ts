/**
 * AC7: MR close（未合并）→ status=aborted
 *
 * seed 一个 pipeline_success 的 report + create_mr 事件
 * 模拟 webhook MR action='close' → lifecycle_sync 事件 + status=aborted
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { resetTestDb } from '../helpers/db.js'
import { baseSeed, seedProject } from '../helpers/bug-fix-seed.js'
import {
  createBugAnalysisReport,
  getBugAnalysisReportById,
  updateReportStatus,
} from '../../db/repositories/bug-analysis-reports.js'
import { createEvent, findByReportCode } from '../../db/repositories/bug-fix-events.js'
import { handleMergeRequestEvent } from '../../adapters/gitlab/issue-handler.js'

describe('AC7: MR close → status=aborted', () => {
  let productLineId: number

  beforeEach(async () => {
    await resetTestDb()
    const seed = await baseSeed()
    productLineId = seed.productLineId
    await seedProject(productLineId, {
      name: 'pas-api',
      gitlabPath: 'PAM/pas-api',
    })
  })

  it('webhook action=close → 写 lifecycle_sync + report.status=aborted', async () => {
    const report = await createBugAnalysisReport({
      issueId: 123,
      issueUrl: 'http://git.example.com/PAM/pas-api/-/issues/123',
      productLineId,
      agentSessionId: null,
      level: 'l2',
      classification: 'bug',
      confidence: 'high',
      confidenceScore: 0.9,
      rootCauseSummary: 'bug',
      solutionsJson: [{ id: 'a', summary: 'fix', recommended: true, risk: 'low', effort: 'small' }],
      affectedModules: null,
      analysisSteps: null,
      metadata: null,
      primaryProjectPath: 'PAM/pas-api',
    })
    await updateReportStatus(report.id, 'pipeline_success')

    // seed create_mr 事件（webhook 反查依赖这个事件）
    await createEvent({
      reportId: report.id,
      projectPath: 'PAM/pas-api',
      code: 'create_mr',
      status: 'success',
      data: {
        mrIid: 77,
        mrUrl: 'http://git.example.com/PAM/pas-api/-/merge_requests/77',
        branch: 'fix/issue-123-1',
        isPrimary: true,
      },
    })

    // 模拟 webhook MR close
    await handleMergeRequestEvent({
      object_kind: 'merge_request',
      object_attributes: {
        iid: 77,
        title: 'fix',
        action: 'close',
        source_branch: 'fix/issue-123-1',
        target_branch: 'test',
      },
      project: { path_with_namespace: 'PAM/pas-api' },
    })

    const after = await getBugAnalysisReportById(report.id)
    expect(after!.status).toBe('aborted')

    const syncEvents = await findByReportCode(report.id, 'lifecycle_sync')
    expect(syncEvents).toHaveLength(1)
    expect((syncEvents[0].data as any).mrAction).toBe('close')
    expect((syncEvents[0].data as any).targetStatus).toBe('aborted')
  })

  it('webhook action=merge → report.status=completed', async () => {
    const report = await createBugAnalysisReport({
      issueId: 124,
      issueUrl: 'http://git.example.com/PAM/pas-api/-/issues/124',
      productLineId,
      agentSessionId: null,
      level: 'l2',
      classification: 'bug',
      confidence: 'high',
      confidenceScore: 0.9,
      rootCauseSummary: 'bug',
      solutionsJson: [{ id: 'a', summary: 'fix', recommended: true, risk: 'low', effort: 'small' }],
      affectedModules: null,
      analysisSteps: null,
      metadata: null,
      primaryProjectPath: 'PAM/pas-api',
    })
    await updateReportStatus(report.id, 'pipeline_success')
    await createEvent({
      reportId: report.id,
      projectPath: 'PAM/pas-api',
      code: 'create_mr',
      status: 'success',
      data: { mrIid: 78, mrUrl: 'http://git.example.com/PAM/pas-api/-/merge_requests/78', branch: 'fix/issue-124-1', isPrimary: true },
    })

    await handleMergeRequestEvent({
      object_kind: 'merge_request',
      object_attributes: { iid: 78, title: 'fix', action: 'merge', source_branch: 'fix/issue-124-1', target_branch: 'test' },
      project: { path_with_namespace: 'PAM/pas-api' },
    })

    const after = await getBugAnalysisReportById(report.id)
    expect(after!.status).toBe('completed')
  })

  it('已处于终态（completed）→ 幂等跳过，不再重复写事件', async () => {
    const report = await createBugAnalysisReport({
      issueId: 125,
      issueUrl: 'http://git.example.com/PAM/pas-api/-/issues/125',
      productLineId,
      agentSessionId: null,
      level: 'l2',
      classification: 'bug',
      confidence: 'high',
      confidenceScore: 0.9,
      rootCauseSummary: 'bug',
      solutionsJson: [],
      affectedModules: null,
      analysisSteps: null,
      metadata: null,
      primaryProjectPath: 'PAM/pas-api',
    })
    await updateReportStatus(report.id, 'completed')
    await createEvent({
      reportId: report.id,
      projectPath: 'PAM/pas-api',
      code: 'create_mr',
      status: 'success',
      data: { mrIid: 79, mrUrl: 'http://git.example.com/PAM/pas-api/-/merge_requests/79', branch: 'fix/issue-125-1', isPrimary: true },
    })

    await handleMergeRequestEvent({
      object_kind: 'merge_request',
      object_attributes: { iid: 79, title: 'fix', action: 'close', source_branch: 'fix/issue-125-1', target_branch: 'test' },
      project: { path_with_namespace: 'PAM/pas-api' },
    })

    // 状态保持 completed，不改成 aborted
    const after = await getBugAnalysisReportById(report.id)
    expect(after!.status).toBe('completed')

    const syncEvents = await findByReportCode(report.id, 'lifecycle_sync')
    expect(syncEvents).toHaveLength(0)
  })
})
