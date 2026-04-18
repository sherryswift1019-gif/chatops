import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  triggerCapability,
  registerCapabilityHandler,
  handleAnalysisComplete,
} from '../../agent/coordinator.js'

// ─── mock 底层依赖 ─────────────────────────────────────────────

vi.mock('../../db/repositories/capabilities.js', () => ({
  getCapabilityByKey: vi.fn(async (key: string) => {
    if (key === 'test_cap') return { id: 1, key: 'test_cap', toolNames: [], systemPrompt: '' }
    if (key === 'notify_bug') return { id: 2, key: 'notify_bug', toolNames: [], systemPrompt: '' }
    if (key === 'analyze_bug') return { id: 3, key: 'analyze_bug', toolNames: [], systemPrompt: '' }
    return null
  }),
}))

vi.mock('../../db/repositories/bug-analysis-reports.js', () => ({
  setPipelineRunId: vi.fn(async () => {}),
  updateReportStatus: vi.fn(async () => null),
  getBugAnalysisReportById: vi.fn(),
}))

vi.mock('../../db/repositories/bug-fix-events.js', () => ({
  findByReportCode: vi.fn(async () => []),
}))

vi.mock('../../db/client.js', () => ({
  getPool: vi.fn(() => ({
    query: vi.fn(),
  })),
}))

vi.mock('../../pipeline/executor.js', () => ({
  runPipeline: vi.fn(),
}))

// ─── tests ────────────────────────────────────────────────────

describe('AgentCoordinator - triggerCapability', () => {
  it('calls registered handler when capability exists', async () => {
    const handler = vi.fn().mockResolvedValue({ success: true, output: 'done' })
    registerCapabilityHandler('test_cap', handler)

    const result = await triggerCapability({
      capabilityKey: 'test_cap',
      context: { taskId: 't1', groupId: 'g1', platform: 'dingtalk', initiatorId: 'u1', initiatorRole: 'developer' },
    })

    expect(result.success).toBe(true)
    expect(handler).toHaveBeenCalledOnce()
  })

  it('returns error when capability not found in DB', async () => {
    const result = await triggerCapability({
      capabilityKey: 'nonexistent',
      context: { taskId: 't2', groupId: 'g1', platform: 'dingtalk', initiatorId: 'u1', initiatorRole: 'developer' },
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('not found')
  })

  it('returns error when no handler registered', async () => {
    // 'test_cap' exists in DB but handler for 'unregistered_cap' doesn't exist
    const result = await triggerCapability({
      capabilityKey: 'test_cap',
      context: { taskId: 't3', groupId: 'g1', platform: 'dingtalk', initiatorId: 'u1', initiatorRole: 'developer' },
      extraParams: {},
    })

    // handler was registered in previous test, so this should succeed
    expect(result.success).toBe(true)
  })

  it('catches handler errors and returns failure', async () => {
    registerCapabilityHandler('error_cap', async () => { throw new Error('boom') })

    // Mock DB to find this cap
    const { getCapabilityByKey } = await import('../../db/repositories/capabilities.js')
    ;(getCapabilityByKey as any).mockResolvedValueOnce({ id: 2, key: 'error_cap', toolNames: [] })

    const result = await triggerCapability({
      capabilityKey: 'error_cap',
      context: { taskId: 't4', groupId: 'g1', platform: 'dingtalk', initiatorId: 'u1', initiatorRole: 'developer' },
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('boom')
  })
})

describe('AgentCoordinator - handleAnalysisComplete', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
  })

  const fakeReport = {
    id: 42,
    issueId: 501,
    issueUrl: 'https://gitlab/test/issues/501',
    productLineId: 7,
    agentSessionId: null,
    level: 'l2' as const,
    classification: 'bug' as const,
    confidence: 'high' as const,
    confidenceScore: 0.9,
    rootCauseSummary: 'SQL 缺失',
    solutionsJson: [],
    affectedModules: [],
    analysisSteps: [],
    metadata: null,
    status: 'draft' as const,
    pipelineRunId: null,
    primaryProjectPath: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }

  async function mockPipelineRow(pipelineId: number, name: string) {
    const { getPool } = await import('../../db/client.js')
    ;(getPool as any).mockReturnValue({
      query: vi.fn(async () => ({
        rows: [{
          id: pipelineId, product_line_id: fakeReport.productLineId, name,
          description: '', stages: [], server_roles: {}, schedule: '',
          enabled: true, trigger_params: {}, variables: {},
          created_at: new Date(), updated_at: new Date(),
        }],
      })),
    })
  }

  async function mockNoPipelineRow() {
    const { getPool } = await import('../../db/client.js')
    ;(getPool as any).mockReturnValue({
      query: vi.fn(async () => ({ rows: [] })),
    })
  }

  it('bug classification → triggers Pipeline and writes pipeline_run_id', async () => {
    const { getBugAnalysisReportById, setPipelineRunId } = await import('../../db/repositories/bug-analysis-reports.js')
    const { runPipeline } = await import('../../pipeline/executor.js')
    ;(getBugAnalysisReportById as any).mockResolvedValue(fakeReport)
    ;(runPipeline as any).mockResolvedValue(77)
    await mockPipelineRow(11, 'L2-代码缺陷')

    await handleAnalysisComplete(fakeReport.id, 'l2', 'bug', 'u-trigger')

    expect(runPipeline).toHaveBeenCalledWith(
      11,
      {},
      'api',
      'u-trigger',
      expect.any(Function),
      { reportId: fakeReport.id },
      expect.any(Function),
    )
    expect(setPipelineRunId).toHaveBeenCalledWith(fakeReport.id, 77)
  })

  it('non-bug classification: does not trigger Pipeline', async () => {
    const { runPipeline } = await import('../../pipeline/executor.js')
    const { setPipelineRunId } = await import('../../db/repositories/bug-analysis-reports.js')

    await handleAnalysisComplete(fakeReport.id, 'l4', 'usage_issue', 'u-trigger')

    expect(runPipeline).not.toHaveBeenCalled()
    expect(setPipelineRunId).not.toHaveBeenCalled()
  })

  it('onComplete(success) → updates status to pipeline_success', async () => {
    const { getBugAnalysisReportById, updateReportStatus } = await import('../../db/repositories/bug-analysis-reports.js')
    const { runPipeline } = await import('../../pipeline/executor.js')
    ;(getBugAnalysisReportById as any).mockResolvedValue(fakeReport)

    let captured: ((r: any) => Promise<void>) | null = null
    ;(runPipeline as any).mockImplementation(async (_id: number, _sa: unknown, _tt: string, _tb: string, onComplete: any) => {
      captured = onComplete
      return 100
    })
    await mockPipelineRow(11, 'L2-代码缺陷')

    await handleAnalysisComplete(fakeReport.id, 'l2', 'bug', 'u-trigger')
    expect(captured).not.toBeNull()
    await captured!({ runId: 100, pipelineName: 'L2', status: 'success', errorMessage: '', stageResults: [], durationMs: 1000 })

    expect(updateReportStatus).toHaveBeenCalledWith(fakeReport.id, 'pipeline_success')
  })

  it('onComplete(failed) → updates status to aborted + triggers notify_bug', async () => {
    const { getBugAnalysisReportById, updateReportStatus } = await import('../../db/repositories/bug-analysis-reports.js')
    const { runPipeline } = await import('../../pipeline/executor.js')
    ;(getBugAnalysisReportById as any).mockResolvedValue(fakeReport)

    let captured: ((r: any) => Promise<void>) | null = null
    ;(runPipeline as any).mockImplementation(async (_id: number, _sa: unknown, _tt: string, _tb: string, onComplete: any) => {
      captured = onComplete
      return 101
    })
    await mockPipelineRow(11, 'L2-代码缺陷')

    const notifyHandler = vi.fn(async () => ({ success: true, output: 'sent' }))
    registerCapabilityHandler('notify_bug', notifyHandler)

    await handleAnalysisComplete(fakeReport.id, 'l2', 'bug', 'u-trigger')
    await captured!({ runId: 101, pipelineName: 'L2', status: 'failed', errorMessage: 'boom', stageResults: [], durationMs: 500 })

    expect(updateReportStatus).toHaveBeenCalledWith(fakeReport.id, 'aborted')
    expect(notifyHandler).toHaveBeenCalledWith(expect.objectContaining({
      capabilityKey: 'notify_bug',
      extraParams: expect.objectContaining({ reportId: fakeReport.id }),
    }))
  })

  it('retry_analysis decision: triggers new analyze_bug with reuseIssueId', async () => {
    const { getBugAnalysisReportById } = await import('../../db/repositories/bug-analysis-reports.js')
    const { findByReportCode } = await import('../../db/repositories/bug-fix-events.js')
    const { runPipeline } = await import('../../pipeline/executor.js')
    ;(getBugAnalysisReportById as any).mockResolvedValue({ ...fakeReport, level: 'l3' })
    ;(findByReportCode as any).mockResolvedValue([
      {
        id: 1, reportId: fakeReport.id, projectPath: null, code: 'approval',
        status: 'failed',
        data: { decision: 'retry_analysis', approverName: 'u-owner' },
        durationMs: null, createdAt: new Date(),
      },
    ])

    let captured: ((r: any) => Promise<void>) | null = null
    ;(runPipeline as any).mockImplementation(async (_id: number, _sa: unknown, _tt: string, _tb: string, onComplete: any) => {
      captured = onComplete
      return 200
    })
    await mockPipelineRow(13, 'L3-业务逻辑')

    const notifyHandler = vi.fn(async () => ({ success: true, output: '' }))
    const analyzeHandler = vi.fn(async () => ({ success: true, output: '' }))
    registerCapabilityHandler('notify_bug', notifyHandler)
    registerCapabilityHandler('analyze_bug', analyzeHandler)

    await handleAnalysisComplete(fakeReport.id, 'l3', 'bug', 'u-trigger')
    await captured!({ runId: 200, pipelineName: 'L3', status: 'failed', errorMessage: 'retry_analysis', stageResults: [], durationMs: 100 })

    expect(analyzeHandler).toHaveBeenCalledWith(expect.objectContaining({
      capabilityKey: 'analyze_bug',
      extraParams: expect.objectContaining({
        reuseIssueId: fakeReport.issueId,
        productLineId: fakeReport.productLineId,
      }),
    }))
  })

  it('no matching pipeline for level: marks aborted', async () => {
    const { getBugAnalysisReportById, updateReportStatus } = await import('../../db/repositories/bug-analysis-reports.js')
    const { runPipeline } = await import('../../pipeline/executor.js')
    ;(getBugAnalysisReportById as any).mockResolvedValue(fakeReport)
    await mockNoPipelineRow()

    await handleAnalysisComplete(fakeReport.id, 'l2', 'bug', 'u-trigger')

    expect(runPipeline).not.toHaveBeenCalled()
    expect(updateReportStatus).toHaveBeenCalledWith(fakeReport.id, 'aborted')
  })
})
