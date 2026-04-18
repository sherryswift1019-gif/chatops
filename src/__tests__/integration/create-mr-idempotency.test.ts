/**
 * AC4: create_mr 幂等
 * 场景：已存在 create_mr 成功事件 → 再调 handleCreateMr → 跳过，不重复调 gitlabCreateMr
 */
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest'

vi.mock('../../agent/mr/gitlab-mr.js', () => ({
  gitlabCreateMr: vi.fn(),
}))

import { resetTestDb } from '../helpers/db.js'
import { baseSeed, seedProject } from '../helpers/bug-fix-seed.js'
import { handleCreateMr } from '../../agent/mr/mr-handler.js'
import { createBugAnalysisReport } from '../../db/repositories/bug-analysis-reports.js'
import { createEvent, findByReportCode } from '../../db/repositories/bug-fix-events.js'
import { gitlabCreateMr } from '../../agent/mr/gitlab-mr.js'

describe('AC4: create_mr 幂等（重试跳过已成功 project）', () => {
  let productLineId: number

  beforeAll(() => {
    /* no-op */
  })

  beforeEach(async () => {
    await resetTestDb()
    vi.clearAllMocks()
    const seed = await baseSeed()
    productLineId = seed.productLineId
    await seedProject(productLineId, {
      name: 'pas-api',
      gitlabPath: 'PAM/pas-api',
      ownerId: 'u-primary',
      ownerName: '主负责人',
    })
  })

  it('已成功的 project 跳过 gitlabCreateMr 调用', async () => {
    // seed 报告 + 各种前置事件
    const report = await createBugAnalysisReport({
      issueId: 55,
      issueUrl: 'http://git.example.com/PAM/pas-api/-/issues/55',
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

    // scope_identified
    await createEvent({
      reportId: report.id,
      projectPath: 'PAM/pas-api',
      code: 'scope_identified',
      data: { isPrimary: true, sourceBranch: 'test' },
    })
    // create_issue (primary)
    await createEvent({
      reportId: report.id,
      projectPath: 'PAM/pas-api',
      code: 'create_issue',
      data: { issueIid: 55, issueUrl: report.issueUrl, isPrimary: true },
    })
    // fix_attempt 成功
    await createEvent({
      reportId: report.id,
      projectPath: 'PAM/pas-api',
      code: 'fix_attempt',
      status: 'success',
      data: { branch: 'fix/issue-55-1', targetBranch: 'test', testResult: true, attempt: 1 },
    })
    // 已有 create_mr 成功事件（模拟上一轮 Pipeline 已创建过）
    await createEvent({
      reportId: report.id,
      projectPath: 'PAM/pas-api',
      code: 'create_mr',
      status: 'success',
      data: {
        mrIid: 88,
        mrUrl: 'http://git.example.com/PAM/pas-api/-/merge_requests/88',
        branch: 'fix/issue-55-1',
        isPrimary: true,
      },
    })

    // 再调 handleCreateMr（模拟 Pipeline 重试）
    const result = await handleCreateMr({
      capabilityKey: 'create_mr',
      context: { taskId: 't', groupId: 'g', platform: 'test', initiatorId: 'u', initiatorRole: 'admin' },
      extraParams: { reportId: report.id },
    })

    expect(result.success).toBe(true)
    expect(result.output).toContain('(已存在)')
    expect(gitlabCreateMr).not.toHaveBeenCalled()

    // create_mr 事件数量不变（幂等：仍然只有 1 条）
    const events = await findByReportCode(report.id, 'create_mr')
    expect(events).toHaveLength(1)
  })
})
