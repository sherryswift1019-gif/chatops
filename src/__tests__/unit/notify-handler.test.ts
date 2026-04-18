import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resetTestDb, getTestPool } from '../helpers/db.js'
import { PipelineApprovalManager } from '../../pipeline/approval-manager.js'
import { handleNotify } from '../../agent/notify/notify-handler.js'
import { createEvent, findByReportCode } from '../../db/repositories/bug-fix-events.js'
import { createBugAnalysisReport, setPipelineRunId } from '../../db/repositories/bug-analysis-reports.js'
import type { IMAdapter } from '../../adapters/im/types.js'

interface ProjectSeed {
  name: string
  gitlabPath: string
  ownerId?: string
  ownerName?: string
}

async function seedProductLine(name = 'pam'): Promise<number> {
  const pool = getTestPool()
  const { rows } = await pool.query(
    `INSERT INTO product_lines (name, display_name, description)
     VALUES ($1, 'PAM', 'test')
     ON CONFLICT (name) DO UPDATE SET display_name = EXCLUDED.display_name
     RETURNING id`,
    [name],
  )
  return rows[0].id as number
}

async function seedProject(productLineId: number, p: ProjectSeed): Promise<void> {
  const pool = getTestPool()
  await pool.query(
    `INSERT INTO projects (product_line_id, name, display_name, gitlab_path, owner_id, owner_name, description)
     VALUES ($1, $2, $3, $4, $5, $6, '')
     ON CONFLICT (name) DO UPDATE
       SET gitlab_path = EXCLUDED.gitlab_path,
           owner_id = EXCLUDED.owner_id,
           owner_name = EXCLUDED.owner_name`,
    [productLineId, p.name, p.name, p.gitlabPath, p.ownerId ?? '', p.ownerName ?? ''],
  )
}

let pipelineSeq = 0
async function seedPipeline(productLineId: number): Promise<number> {
  const pool = getTestPool()
  pipelineSeq += 1
  const { rows } = await pool.query(
    `INSERT INTO test_pipelines (name, description, stages, product_line_id)
     VALUES ($1, 'x', '[]'::jsonb, $2) RETURNING id`,
    [`test-p-${pipelineSeq}-${Date.now()}`, productLineId],
  )
  return rows[0].id as number
}

async function seedTestRun(pipelineId: number, triggeredBy: string): Promise<number> {
  const pool = getTestPool()
  const { rows } = await pool.query(
    `INSERT INTO test_runs (pipeline_id, trigger_type, triggered_by, servers, status, started_at)
     VALUES ($1, 'api', $2, '{}'::jsonb, 'running', NOW()) RETURNING id`,
    [pipelineId, triggeredBy],
  )
  return rows[0].id as number
}

interface SeedReportOpts {
  productLineId: number
  primaryProjectPath: string
  level?: 'l1' | 'l2' | 'l3' | 'l4'
  classification?: 'bug' | 'config_issue' | 'usage_issue'
  triggeredBy?: string
}

async function seedReport(opts: SeedReportOpts) {
  const report = await createBugAnalysisReport({
    issueId: 888,
    issueUrl: `http://git.example.com/${opts.primaryProjectPath}/-/issues/888`,
    productLineId: opts.productLineId,
    agentSessionId: null,
    level: opts.level ?? 'l2',
    classification: opts.classification ?? 'bug',
    confidence: 'medium',
    confidenceScore: 0.8,
    rootCauseSummary: 'token 过期校验缺失',
    solutionsJson: [
      { id: 'a', summary: '增加过期校验', recommended: true, risk: 'low', effort: 'small' },
    ],
    affectedModules: ['auth'],
    analysisSteps: null,
    metadata: null,
    primaryProjectPath: opts.primaryProjectPath,
  })
  if (opts.triggeredBy) {
    const pipelineId = await seedPipeline(opts.productLineId)
    const runId = await seedTestRun(pipelineId, opts.triggeredBy)
    await setPipelineRunId(report.id, runId)
  }
  return report
}

async function seedFixSuccessWithMr(
  reportId: number,
  projectPath: string,
  isPrimary: boolean,
  mrIid: number,
): Promise<void> {
  await createEvent({
    reportId,
    projectPath,
    code: 'scope_identified',
    data: { isPrimary },
  })
  await createEvent({
    reportId,
    projectPath,
    code: 'fix_attempt',
    status: 'success',
    data: { branch: `fix/issue-888`, isPrimary },
  })
  await createEvent({
    reportId,
    projectPath,
    code: 'create_mr',
    status: 'success',
    data: {
      mrIid,
      mrUrl: `http://gitlab/${projectPath}/-/merge_requests/${mrIid}`,
      branch: `fix/issue-888`,
      isPrimary,
    },
  })
}

async function seedReviewEvent(
  reportId: number,
  projectPath: string,
  label: 'ai-approved' | 'ai-needs-attention',
): Promise<void> {
  await createEvent({
    reportId,
    projectPath,
    code: 'ai_review',
    status: 'success',
    data: { label },
  })
}

function makeMockAdapter(): IMAdapter & { sendDirectMessage: ReturnType<typeof vi.fn> } {
  const fn = vi.fn().mockResolvedValue(undefined)
  return {
    platform: 'dingtalk',
    onMessage: vi.fn(),
    sendMessage: vi.fn(),
    sendCard: vi.fn(),
    sendDirectMessage: fn,
    getUserInfo: vi.fn(),
    onCardAction: vi.fn(),
    handleWebhook: vi.fn(),
  } as unknown as IMAdapter & { sendDirectMessage: ReturnType<typeof vi.fn> }
}

const baseCtx = {
  taskId: 't',
  groupId: 'g',
  platform: 'pipeline',
  initiatorId: 'p',
  initiatorRole: 'admin' as const,
}

describe('notify_bug handler', () => {
  let mockAdapter: IMAdapter & { sendDirectMessage: ReturnType<typeof vi.fn> }

  beforeEach(async () => {
    await resetTestDb()
    mockAdapter = makeMockAdapter()
    PipelineApprovalManager.initialize([mockAdapter])
    vi.restoreAllMocks()
  })

  it('fix_success: triggers owner DM + triggered_by DM', async () => {
    const productLineId = await seedProductLine()
    await seedProject(productLineId, {
      name: 'pas-api',
      gitlabPath: 'PAM/pas-api',
      ownerId: 'u-api',
      ownerName: '小张',
    })
    const report = await seedReport({
      productLineId,
      primaryProjectPath: 'PAM/pas-api',
      triggeredBy: 'u-trigger',
    })
    await seedFixSuccessWithMr(report.id, 'PAM/pas-api', true, 55)
    await seedReviewEvent(report.id, 'PAM/pas-api', 'ai-approved')

    const result = await handleNotify({
      capabilityKey: 'notify_bug',
      context: baseCtx,
      extraParams: { reportId: report.id },
    })

    expect(result.success).toBe(true)
    expect(mockAdapter.sendDirectMessage).toHaveBeenCalledTimes(2)
    const calls = mockAdapter.sendDirectMessage.mock.calls
    const ownerCall = calls.find(c => c[0] === 'u-api')
    const triggerCall = calls.find(c => c[0] === 'u-trigger')
    expect(ownerCall).toBeTruthy()
    expect(triggerCall).toBeTruthy()
    const ownerText = (ownerCall![1] as { text: string }).text
    const triggerText = (triggerCall![1] as { text: string }).text
    expect(ownerText).toContain('PAM/pas-api')
    expect(ownerText).toContain('/merge_requests/55')
    expect(ownerText).toContain('ai-approved')
    expect(triggerText).toContain('Bug 已自动修复')
    expect(triggerText).toContain('/merge_requests/55')

    const events = await findByReportCode(report.id, 'notify')
    expect(events).toHaveLength(2)
    expect(events.every(e => e.status === 'success')).toBe(true)
    const ownerEvent = events.find(e => (e.data as Record<string, unknown>).userId === 'u-api')
    expect(ownerEvent?.data).toMatchObject({
      role: 'owner',
      messageKind: 'fix_success',
      mrIids: [55],
    })
    const triggerEvent = events.find(e => (e.data as Record<string, unknown>).userId === 'u-trigger')
    expect(triggerEvent?.data).toMatchObject({
      role: 'initiator',
      messageKind: 'fix_success',
    })
  })

  it('fix_success_review_concerns: owner message includes needs-attention warning', async () => {
    const productLineId = await seedProductLine()
    await seedProject(productLineId, {
      name: 'pas-api',
      gitlabPath: 'PAM/pas-api',
      ownerId: 'u-api',
      ownerName: '小张',
    })
    const report = await seedReport({
      productLineId,
      primaryProjectPath: 'PAM/pas-api',
      triggeredBy: 'u-trigger',
    })
    await seedFixSuccessWithMr(report.id, 'PAM/pas-api', true, 77)
    await seedReviewEvent(report.id, 'PAM/pas-api', 'ai-needs-attention')

    await handleNotify({
      capabilityKey: 'notify_bug',
      context: baseCtx,
      extraParams: { reportId: report.id },
    })

    const events = await findByReportCode(report.id, 'notify')
    const ownerEvent = events.find(e => (e.data as Record<string, unknown>).role === 'owner')
    expect((ownerEvent?.data as Record<string, unknown>).messageKind).toBe('fix_success_review_concerns')

    const ownerCall = mockAdapter.sendDirectMessage.mock.calls.find(c => c[0] === 'u-api')
    const ownerText = (ownerCall![1] as { text: string }).text
    expect(ownerText).toContain('ai-needs-attention')
    expect(ownerText).toContain('AI Review 发现问题')
  })

  it('fix_failed: only triggered_by gets DM with failure reason', async () => {
    const productLineId = await seedProductLine()
    await seedProject(productLineId, {
      name: 'pas-api',
      gitlabPath: 'PAM/pas-api',
      ownerId: 'u-api',
      ownerName: '小张',
    })
    const report = await seedReport({
      productLineId,
      primaryProjectPath: 'PAM/pas-api',
      triggeredBy: 'u-trigger',
    })
    await createEvent({
      reportId: report.id,
      projectPath: 'PAM/pas-api',
      code: 'scope_identified',
      data: { isPrimary: true },
    })
    await createEvent({
      reportId: report.id,
      projectPath: 'PAM/pas-api',
      code: 'fix_attempt',
      status: 'failed',
      data: { error: 'patch 应用冲突', isPrimary: true },
    })

    const result = await handleNotify({
      capabilityKey: 'notify_bug',
      context: baseCtx,
      extraParams: { reportId: report.id },
    })

    expect(result.success).toBe(true)
    expect(mockAdapter.sendDirectMessage).toHaveBeenCalledTimes(1)
    expect(mockAdapter.sendDirectMessage).toHaveBeenCalledWith('u-trigger', expect.anything())
    const [, content] = mockAdapter.sendDirectMessage.mock.calls[0]
    expect((content as { text: string }).text).toContain('修复失败')
    expect((content as { text: string }).text).toContain('patch 应用冲突')
  })

  it('l4_created: only triggered_by DM with Issue link', async () => {
    const productLineId = await seedProductLine()
    const report = await seedReport({
      productLineId,
      primaryProjectPath: 'PAM/pas-api',
      level: 'l4',
      classification: 'bug',
      triggeredBy: 'u-trigger',
    })

    const result = await handleNotify({
      capabilityKey: 'notify_bug',
      context: baseCtx,
      extraParams: { reportId: report.id },
    })

    expect(result.success).toBe(true)
    expect(mockAdapter.sendDirectMessage).toHaveBeenCalledTimes(1)
    const [userId, content] = mockAdapter.sendDirectMessage.mock.calls[0]
    expect(userId).toBe('u-trigger')
    expect((content as { text: string }).text).toContain('AI 无法自动修复')
    expect((content as { text: string }).text).toContain(report.issueUrl)
    const events = await findByReportCode(report.id, 'notify')
    expect((events[0].data as Record<string, unknown>).messageKind).toBe('l4_created')
  })

  it('approval_rejected / timeout / retry_analysis: only triggered_by', async () => {
    for (const decision of ['rejected', 'timeout', 'retry_analysis'] as const) {
      await resetTestDb()
      mockAdapter = makeMockAdapter()
      PipelineApprovalManager.initialize([mockAdapter])

      const productLineId = await seedProductLine()
      await seedProject(productLineId, {
        name: 'pas-api',
        gitlabPath: 'PAM/pas-api',
        ownerId: 'u-api',
      })
      const report = await seedReport({
        productLineId,
        primaryProjectPath: 'PAM/pas-api',
        level: 'l3',
        triggeredBy: 'u-trigger',
      })
      await createEvent({
        reportId: report.id,
        projectPath: 'PAM/pas-api',
        code: 'scope_identified',
        data: { isPrimary: true },
      })
      await createEvent({
        reportId: report.id,
        projectPath: null,
        code: 'approval',
        status: decision === 'rejected' || decision === 'timeout' || decision === 'retry_analysis' ? 'failed' : 'success',
        data: { decision },
      })

      await handleNotify({
        capabilityKey: 'notify_bug',
        context: baseCtx,
        extraParams: { reportId: report.id },
      })

      expect(mockAdapter.sendDirectMessage).toHaveBeenCalledTimes(1)
      expect(mockAdapter.sendDirectMessage).toHaveBeenCalledWith('u-trigger', expect.anything())
      const events = await findByReportCode(report.id, 'notify')
      expect(events).toHaveLength(1)
      const expectedKind = decision === 'rejected'
        ? 'approval_rejected'
        : decision === 'timeout' ? 'approval_timeout' : 'approval_retry_analysis'
      expect((events[0].data as Record<string, unknown>).messageKind).toBe(expectedKind)
    }
  })

  it('deduplicates owners: same user owns multiple projects → one DM with combined MRs', async () => {
    const productLineId = await seedProductLine()
    await seedProject(productLineId, {
      name: 'a',
      gitlabPath: 'PAM/a',
      ownerId: 'u-shared',
      ownerName: '共享',
    })
    await seedProject(productLineId, {
      name: 'b',
      gitlabPath: 'PAM/b',
      ownerId: 'u-shared',
      ownerName: '共享',
    })
    const report = await seedReport({
      productLineId,
      primaryProjectPath: 'PAM/a',
      triggeredBy: 'u-trigger',
    })
    await seedFixSuccessWithMr(report.id, 'PAM/a', true, 1)
    await seedFixSuccessWithMr(report.id, 'PAM/b', false, 2)
    await seedReviewEvent(report.id, 'PAM/a', 'ai-approved')
    await seedReviewEvent(report.id, 'PAM/b', 'ai-approved')

    await handleNotify({
      capabilityKey: 'notify_bug',
      context: baseCtx,
      extraParams: { reportId: report.id },
    })

    const events = await findByReportCode(report.id, 'notify')
    const ownerEvents = events.filter(e => (e.data as Record<string, unknown>).role === 'owner')
    expect(ownerEvents).toHaveLength(1)
    const mrIids = (ownerEvents[0].data as Record<string, unknown>).mrIids as number[]
    expect([...mrIids].sort((a, b) => a - b)).toEqual([1, 2])

    const ownerCall = mockAdapter.sendDirectMessage.mock.calls.find(c => c[0] === 'u-shared')
    expect(ownerCall).toBeTruthy()
    const ownerText = (ownerCall![1] as { text: string }).text
    expect(ownerText).toContain('/merge_requests/1')
    expect(ownerText).toContain('/merge_requests/2')
  })

  it('DM failure: records failed event, continues other recipients, returns im_api_error', async () => {
    const productLineId = await seedProductLine()
    await seedProject(productLineId, {
      name: 'pas-api',
      gitlabPath: 'PAM/pas-api',
      ownerId: 'u-api',
      ownerName: '小张',
    })
    const report = await seedReport({
      productLineId,
      primaryProjectPath: 'PAM/pas-api',
      triggeredBy: 'u-trigger',
    })
    await seedFixSuccessWithMr(report.id, 'PAM/pas-api', true, 33)
    await seedReviewEvent(report.id, 'PAM/pas-api', 'ai-approved')

    mockAdapter.sendDirectMessage
      .mockRejectedValueOnce(new Error('网络错误'))
      .mockResolvedValueOnce(undefined)

    const result = await handleNotify({
      capabilityKey: 'notify_bug',
      context: baseCtx,
      extraParams: { reportId: report.id },
    })

    expect(result.success).toBe(false)
    expect(result.error).toBe('im_api_error')
    expect(mockAdapter.sendDirectMessage).toHaveBeenCalledTimes(2)
    const events = await findByReportCode(report.id, 'notify')
    expect(events).toHaveLength(2)
    const failed = events.filter(e => e.status === 'failed')
    const success = events.filter(e => e.status === 'success')
    expect(failed).toHaveLength(1)
    expect(success).toHaveLength(1)
    expect((failed[0].data as Record<string, unknown>).error).toContain('网络错误')
  })

  it('no owner configured: skips that owner silently, still sends to triggered_by', async () => {
    const productLineId = await seedProductLine()
    await seedProject(productLineId, {
      name: 'pas-api',
      gitlabPath: 'PAM/pas-api',
      ownerId: '',
      ownerName: '',
    })
    const report = await seedReport({
      productLineId,
      primaryProjectPath: 'PAM/pas-api',
      triggeredBy: 'u-trigger',
    })
    await seedFixSuccessWithMr(report.id, 'PAM/pas-api', true, 44)
    await seedReviewEvent(report.id, 'PAM/pas-api', 'ai-approved')

    const result = await handleNotify({
      capabilityKey: 'notify_bug',
      context: baseCtx,
      extraParams: { reportId: report.id },
    })

    expect(result.success).toBe(true)
    expect(mockAdapter.sendDirectMessage).toHaveBeenCalledTimes(1)
    expect(mockAdapter.sendDirectMessage).toHaveBeenCalledWith('u-trigger', expect.anything())
    const events = await findByReportCode(report.id, 'notify')
    expect(events).toHaveLength(1)
    expect((events[0].data as Record<string, unknown>).role).toBe('initiator')
  })

  it('missing reportId → returns missing_reportId', async () => {
    const result = await handleNotify({
      capabilityKey: 'notify_bug',
      context: baseCtx,
      extraParams: {},
    })
    expect(result.success).toBe(false)
    expect(result.error).toBe('missing_reportId')
  })

  it('report not found → returns report_not_found', async () => {
    const result = await handleNotify({
      capabilityKey: 'notify_bug',
      context: baseCtx,
      extraParams: { reportId: 999999 },
    })
    expect(result.success).toBe(false)
    expect(result.error).toBe('report_not_found')
  })

  it('no recipients (no owner + no triggered_by) → returns no_recipients', async () => {
    const productLineId = await seedProductLine()
    await seedProject(productLineId, {
      name: 'pas-api',
      gitlabPath: 'PAM/pas-api',
      ownerId: '',
      ownerName: '',
    })
    const report = await seedReport({
      productLineId,
      primaryProjectPath: 'PAM/pas-api',
      // 不设置 triggeredBy
    })
    await seedFixSuccessWithMr(report.id, 'PAM/pas-api', true, 1)
    await seedReviewEvent(report.id, 'PAM/pas-api', 'ai-approved')

    const result = await handleNotify({
      capabilityKey: 'notify_bug',
      context: baseCtx,
      extraParams: { reportId: report.id },
    })

    expect(result.success).toBe(false)
    expect(result.error).toBe('no_recipients')
    expect(mockAdapter.sendDirectMessage).not.toHaveBeenCalled()
  })
})
