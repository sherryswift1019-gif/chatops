import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resetTestDb, getTestPool } from '../helpers/db.js'
import { PipelineApprovalManager } from '../../pipeline/approval-manager.js'
import { handleApproveL3 } from '../../agent/approval/approve-l3-handler.js'
import {
  createEvent,
  findByReportCode,
} from '../../db/repositories/bug-fix-events.js'
import { createBugAnalysisReport } from '../../db/repositories/bug-analysis-reports.js'
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

async function seedReport(productLineId: number, primaryProjectPath: string | null) {
  return await createBugAnalysisReport({
    issueId: 333,
    issueUrl: 'http://git.example.com/PAM/pas-6.0/-/issues/333',
    productLineId,
    agentSessionId: null,
    level: 'l3',
    classification: 'bug',
    confidence: 'medium',
    confidenceScore: 0.7,
    rootCauseSummary: 'token 签发模块缺少过期校验，引发跨服务鉴权异常',
    solutionsJson: [
      { id: 'a', summary: '增加过期校验', recommended: true, risk: 'low', effort: 'small' },
    ],
    affectedModules: ['auth'],
    analysisSteps: null,
    metadata: null,
    primaryProjectPath,
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

describe('approve_l3 handler', () => {
  let mockAdapter: IMAdapter & { sendDirectMessage: ReturnType<typeof vi.fn> }

  beforeEach(async () => {
    await resetTestDb()
    mockAdapter = makeMockAdapter()
    PipelineApprovalManager.initialize([mockAdapter])
    vi.restoreAllMocks()
  })

  it('approved → returns success and writes approval event', async () => {
    const productLineId = await seedProductLine()
    await seedProject(productLineId, {
      name: 'pas-6.0',
      gitlabPath: 'PAM/pas-6.0',
      ownerId: 'u-primary',
      ownerName: '张三',
    })
    const report = await seedReport(productLineId, 'PAM/pas-6.0')

    vi.spyOn(PipelineApprovalManager.prototype, 'requestApproval').mockResolvedValue('approved')

    const result = await handleApproveL3({
      capabilityKey: 'approve_l3',
      context: { taskId: 't', groupId: 'g', platform: 'pipeline', initiatorId: 'p', initiatorRole: 'admin' },
      extraParams: { reportId: report.id },
    })

    expect(result.success).toBe(true)
    expect(result.output).toContain('审批通过')

    const events = await findByReportCode(report.id, 'approval')
    expect(events).toHaveLength(1)
    expect(events[0].status).toBe('success')
    expect((events[0].data as Record<string, unknown>).decision).toBe('approved')
    expect((events[0].data as Record<string, unknown>).approverId).toBe('u-primary')
  })

  it('rejected / timeout / retry_analysis → returns failure with that error code', async () => {
    const productLineId = await seedProductLine()
    await seedProject(productLineId, {
      name: 'pas-6.0',
      gitlabPath: 'PAM/pas-6.0',
      ownerId: 'u-primary',
      ownerName: '张三',
    })
    const report = await seedReport(productLineId, 'PAM/pas-6.0')

    for (const decision of ['rejected', 'timeout', 'retry_analysis'] as const) {
      vi.spyOn(PipelineApprovalManager.prototype, 'requestApproval').mockResolvedValue(
        decision as never,
      )

      const r = await handleApproveL3({
        capabilityKey: 'approve_l3',
        context: { taskId: 't', groupId: 'g', platform: 'pipeline', initiatorId: 'p', initiatorRole: 'admin' },
        extraParams: { reportId: report.id },
      })

      expect(r.success).toBe(false)
      expect(r.error).toBe(decision)
    }

    const events = await findByReportCode(report.id, 'approval')
    expect(events).toHaveLength(3)
    expect(events.every(e => e.status === 'failed')).toBe(true)
  })

  it('multi-project: sends FYI DM to other-repo owners but not primary', async () => {
    const productLineId = await seedProductLine()
    await seedProject(productLineId, {
      name: 'pas-6.0',
      gitlabPath: 'PAM/pas-6.0',
      ownerId: 'u-primary',
      ownerName: '主负责人',
    })
    await seedProject(productLineId, {
      name: 'pas-api',
      gitlabPath: 'PAM/pas-api',
      ownerId: 'u-secondary',
      ownerName: '从仓库负责人',
    })
    const report = await seedReport(productLineId, 'PAM/pas-6.0')

    // 模拟 scope_identified 事件：两个 project
    await createEvent({
      reportId: report.id,
      projectPath: 'PAM/pas-6.0',
      code: 'scope_identified',
      data: { isPrimary: true },
    })
    await createEvent({
      reportId: report.id,
      projectPath: 'PAM/pas-api',
      code: 'scope_identified',
      data: { isPrimary: false },
    })

    vi.spyOn(PipelineApprovalManager.prototype, 'requestApproval').mockResolvedValue('approved')

    await handleApproveL3({
      capabilityKey: 'approve_l3',
      context: { taskId: 't', groupId: 'g', platform: 'pipeline', initiatorId: 'p', initiatorRole: 'admin' },
      extraParams: { reportId: report.id },
    })

    // 只有从仓库 owner 收到 FYI DM（主仓库 owner 的审批 DM 由 approval-manager 发，被 mock 拦截了）
    expect(mockAdapter.sendDirectMessage).toHaveBeenCalledTimes(1)
    expect(mockAdapter.sendDirectMessage).toHaveBeenCalledWith('u-secondary', expect.anything())
  })

  it('deduplicates owners: same user owns multiple non-primary projects', async () => {
    const productLineId = await seedProductLine()
    await seedProject(productLineId, {
      name: 'pas-6.0',
      gitlabPath: 'PAM/pas-6.0',
      ownerId: 'u-primary',
      ownerName: '主',
    })
    // 两个从仓库，owner_id 相同
    await seedProject(productLineId, {
      name: 'pas-api',
      gitlabPath: 'PAM/pas-api',
      ownerId: 'u-shared',
      ownerName: '共享负责人',
    })
    await seedProject(productLineId, {
      name: 'pas-web',
      gitlabPath: 'PAM/pas-web',
      ownerId: 'u-shared',
      ownerName: '共享负责人',
    })
    const report = await seedReport(productLineId, 'PAM/pas-6.0')
    await createEvent({
      reportId: report.id,
      projectPath: 'PAM/pas-6.0',
      code: 'scope_identified',
      data: { isPrimary: true },
    })
    await createEvent({
      reportId: report.id,
      projectPath: 'PAM/pas-api',
      code: 'scope_identified',
      data: { isPrimary: false },
    })
    await createEvent({
      reportId: report.id,
      projectPath: 'PAM/pas-web',
      code: 'scope_identified',
      data: { isPrimary: false },
    })

    vi.spyOn(PipelineApprovalManager.prototype, 'requestApproval').mockResolvedValue('approved')

    await handleApproveL3({
      capabilityKey: 'approve_l3',
      context: { taskId: 't', groupId: 'g', platform: 'pipeline', initiatorId: 'p', initiatorRole: 'admin' },
      extraParams: { reportId: report.id },
    })

    // 去重后只发一次
    expect(mockAdapter.sendDirectMessage).toHaveBeenCalledTimes(1)
    expect(mockAdapter.sendDirectMessage).toHaveBeenCalledWith('u-shared', expect.anything())
  })

  it('excludes primary owner from FYI recipients', async () => {
    const productLineId = await seedProductLine()
    await seedProject(productLineId, {
      name: 'pas-6.0',
      gitlabPath: 'PAM/pas-6.0',
      ownerId: 'u-primary',
      ownerName: '主',
    })
    // 从仓库 owner 恰好和主仓库一致
    await seedProject(productLineId, {
      name: 'pas-api',
      gitlabPath: 'PAM/pas-api',
      ownerId: 'u-primary',
      ownerName: '主',
    })
    const report = await seedReport(productLineId, 'PAM/pas-6.0')
    await createEvent({
      reportId: report.id,
      projectPath: 'PAM/pas-6.0',
      code: 'scope_identified',
      data: { isPrimary: true },
    })
    await createEvent({
      reportId: report.id,
      projectPath: 'PAM/pas-api',
      code: 'scope_identified',
      data: { isPrimary: false },
    })

    vi.spyOn(PipelineApprovalManager.prototype, 'requestApproval').mockResolvedValue('approved')

    await handleApproveL3({
      capabilityKey: 'approve_l3',
      context: { taskId: 't', groupId: 'g', platform: 'pipeline', initiatorId: 'p', initiatorRole: 'admin' },
      extraParams: { reportId: report.id },
    })

    // 主 owner 已经由 approval-manager 发审批 DM，此处不应重复发 FYI
    expect(mockAdapter.sendDirectMessage).not.toHaveBeenCalled()
  })

  it('no primary owner → returns no_primary_owner', async () => {
    const productLineId = await seedProductLine()
    await seedProject(productLineId, {
      name: 'pas-6.0',
      gitlabPath: 'PAM/pas-6.0',
      ownerId: '',
      ownerName: '',
    })
    const report = await seedReport(productLineId, 'PAM/pas-6.0')

    const r = await handleApproveL3({
      capabilityKey: 'approve_l3',
      context: { taskId: 't', groupId: 'g', platform: 'pipeline', initiatorId: 'p', initiatorRole: 'admin' },
      extraParams: { reportId: report.id },
    })

    expect(r.success).toBe(false)
    expect(r.error).toBe('no_primary_owner')
  })

  it('missing reportId → returns missing_reportId', async () => {
    const r = await handleApproveL3({
      capabilityKey: 'approve_l3',
      context: { taskId: 't', groupId: 'g', platform: 'pipeline', initiatorId: 'p', initiatorRole: 'admin' },
      extraParams: {},
    })
    expect(r.success).toBe(false)
    expect(r.error).toBe('missing_reportId')
  })

  it('report not found → returns report_not_found', async () => {
    const r = await handleApproveL3({
      capabilityKey: 'approve_l3',
      context: { taskId: 't', groupId: 'g', platform: 'pipeline', initiatorId: 'p', initiatorRole: 'admin' },
      extraParams: { reportId: 99999 },
    })
    expect(r.success).toBe(false)
    expect(r.error).toBe('report_not_found')
  })
})
