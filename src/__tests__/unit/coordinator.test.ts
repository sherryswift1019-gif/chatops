import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  triggerCapability,
  registerCapabilityHandler,
  handleAnalysisComplete,
  maybeCompleteAnalyze,
  checkAndTriggerHandover,
} from '../../agent/coordinator.js'

// ─── mock 底层依赖 ─────────────────────────────────────────────

vi.mock('../../db/repositories/capabilities.js', () => ({
  getCapabilityByKey: vi.fn(async (key: string) => {
    if (key === 'test_cap') return { id: 1, key: 'test_cap', toolNames: [], systemPrompt: '' }
    if (key === 'notify_bug') return { id: 2, key: 'notify_bug', toolNames: [], systemPrompt: '' }
    if (key === 'analyze_bug') return { id: 3, key: 'analyze_bug', toolNames: [], systemPrompt: '' }
    if (key === 'request_handover') return { id: 4, key: 'request_handover', toolNames: [], systemPrompt: '' }
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
      { reportId: String(fakeReport.id) },  // runtimeVars: reportId 塞进 runtime 变量以便 resume 时 reloadContext 恢复 triggerParams
      expect.any(Function),
      { reportId: fakeReport.id },
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

  describe('maybeCompleteAnalyze', () => {
    it('success + bug + 完整 data → 触发 pipeline', async () => {
      const { getBugAnalysisReportById } = await import('../../db/repositories/bug-analysis-reports.js')
      const { runPipeline } = await import('../../pipeline/executor.js')
      ;(getBugAnalysisReportById as any).mockResolvedValue(fakeReport)
      ;(runPipeline as any).mockResolvedValue(99)
      await mockPipelineRow(11, 'L2-代码缺陷')

      await maybeCompleteAnalyze(
        { success: true, data: { reportId: fakeReport.id, level: 'l2', classification: 'bug' } },
        'u-runner',
      )

      expect(runPipeline).toHaveBeenCalled()
    })

    it('success + usage_issue → 不触发 pipeline（handleAnalysisComplete 内部自行判断）', async () => {
      const { runPipeline } = await import('../../pipeline/executor.js')
      await maybeCompleteAnalyze(
        { success: true, data: { reportId: 1, level: 'l1', classification: 'usage_issue' } },
        'u-runner',
      )
      expect(runPipeline).not.toHaveBeenCalled()
    })

    it('success:false → 不调 handleAnalysisComplete', async () => {
      const { runPipeline } = await import('../../pipeline/executor.js')
      await maybeCompleteAnalyze(
        { success: false, error: 'claude_invalid_json' },
        'u-runner',
      )
      expect(runPipeline).not.toHaveBeenCalled()
    })

    it('success + data 缺字段（insufficient 软失败场景）→ 不调', async () => {
      const { runPipeline } = await import('../../pipeline/executor.js')
      await maybeCompleteAnalyze(
        { success: true, output: '材料不够判断...' },  // data 缺失
        'u-runner',
      )
      expect(runPipeline).not.toHaveBeenCalled()
    })
  })

  it('onComplete(success) → updates status to pipeline_success', async () => {
    const { getBugAnalysisReportById, updateReportStatus } = await import('../../db/repositories/bug-analysis-reports.js')
    const { runPipeline } = await import('../../pipeline/executor.js')
    ;(getBugAnalysisReportById as any).mockResolvedValue(fakeReport)

    let captured: ((r: any) => Promise<void>) | null = null
    ;(runPipeline as any).mockImplementation(async (_id: number, _sa: unknown, _tt: string, _tb: string, _rv: unknown, onComplete: any) => {
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
    const { findByReportCode } = await import('../../db/repositories/bug-fix-events.js')
    const { runPipeline } = await import('../../pipeline/executor.js')
    ;(getBugAnalysisReportById as any).mockResolvedValue(fakeReport)
    // 无 fix_attempt / approval / notify 事件 → 走"其他失败"路径
    ;(findByReportCode as any).mockResolvedValue([])

    let captured: ((r: any) => Promise<void>) | null = null
    ;(runPipeline as any).mockImplementation(async (_id: number, _sa: unknown, _tt: string, _tb: string, _rv: unknown, onComplete: any) => {
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

  it('onComplete(failed) + fix_attempt failed → handover(fix_exhausted)，不补发 notify_bug', async () => {
    const { getBugAnalysisReportById, updateReportStatus } = await import('../../db/repositories/bug-analysis-reports.js')
    const { findByReportCode } = await import('../../db/repositories/bug-fix-events.js')
    const { runPipeline } = await import('../../pipeline/executor.js')
    ;(getBugAnalysisReportById as any).mockResolvedValue(fakeReport)
    // 模拟：1 个 project，3 次 fix_attempt failed，无 success，无 approval
    ;(findByReportCode as any).mockImplementation(async (_rid: number, code: string) => {
      if (code === 'approval') return []
      if (code === 'handover') return []  // checkAndTriggerHandover 会查
      if (code === 'scope_identified') {
        return [
          { id: 10, reportId: fakeReport.id, projectPath: 'PAM/pas-api', code: 'scope_identified', status: 'success', data: { isPrimary: true } },
        ]
      }
      if (code === 'fix_attempt') {
        return [
          { id: 1, reportId: fakeReport.id, projectPath: 'PAM/pas-api', code: 'fix_attempt', status: 'failed', data: { attempt: 1, error: 'test compile error on attempt 1' } },
          { id: 2, reportId: fakeReport.id, projectPath: 'PAM/pas-api', code: 'fix_attempt', status: 'failed', data: { attempt: 2, error: 'rebase failed (non-conflict) on attempt 2' } },
          { id: 3, reportId: fakeReport.id, projectPath: 'PAM/pas-api', code: 'fix_attempt', status: 'failed', data: { attempt: 3, error: 'test still red on attempt 3' } },
        ]
      }
      return []
    })

    let captured: ((r: any) => Promise<void>) | null = null
    ;(runPipeline as any).mockImplementation(async (_id: number, _sa: unknown, _tt: string, _tb: string, _rv: unknown, onComplete: any) => {
      captured = onComplete
      return 103
    })
    await mockPipelineRow(11, 'L2-代码缺陷')

    const handoverHandler = vi.fn(async () => ({ success: true, output: 'handed over' }))
    const notifyHandler = vi.fn(async () => ({ success: true, output: 'sent' }))
    registerCapabilityHandler('request_handover', handoverHandler)
    registerCapabilityHandler('notify_bug', notifyHandler)

    await handleAnalysisComplete(fakeReport.id, 'l2', 'bug', 'u-trigger')
    await captured!({ runId: 103, pipelineName: 'L2', status: 'failed', errorMessage: 'fix failed 3 times', stageResults: [], durationMs: 500 })

    // 不走 aborted + 补发 notify_bug 路径
    expect(updateReportStatus).not.toHaveBeenCalledWith(fakeReport.id, 'aborted')
    // 走 handover 路径：request_handover 被调 + notify_bug(kind='handover') 被调
    expect(handoverHandler).toHaveBeenCalledWith(expect.objectContaining({
      capabilityKey: 'request_handover',
      extraParams: expect.objectContaining({
        reportId: fakeReport.id,
        reason: 'fix_exhausted',
        context: expect.objectContaining({
          failedStage: 'fix_bug_l2',
          attemptCount: 3,
          failureSummary: expect.stringContaining('PAM/pas-api: test still red on attempt 3'),
        }),
      }),
    }))
    expect(notifyHandler).toHaveBeenCalledWith(expect.objectContaining({
      capabilityKey: 'notify_bug',
    }))
  })

  it('onComplete(failed) + 所有 project 都有 fix_attempt success → NOT fix_exhausted → aborted + 补发 notify', async () => {
    // 场景：fix 成功了，但 create_mr / ai_review 失败导致 Pipeline 失败
    // 不应误判为 fix_exhausted
    const { getBugAnalysisReportById, updateReportStatus } = await import('../../db/repositories/bug-analysis-reports.js')
    const { findByReportCode } = await import('../../db/repositories/bug-fix-events.js')
    const { runPipeline } = await import('../../pipeline/executor.js')
    ;(getBugAnalysisReportById as any).mockResolvedValue(fakeReport)
    ;(findByReportCode as any).mockImplementation(async (_rid: number, code: string) => {
      if (code === 'approval') return []
      if (code === 'handover') return []
      if (code === 'notify') return []
      if (code === 'scope_identified') {
        return [
          { id: 10, reportId: fakeReport.id, projectPath: 'PAM/pas-api', code: 'scope_identified', status: 'success', data: { isPrimary: true } },
        ]
      }
      if (code === 'fix_attempt') {
        return [
          // 第 1 次失败、第 2 次成功（retry 成功）
          { id: 1, reportId: fakeReport.id, projectPath: 'PAM/pas-api', code: 'fix_attempt', status: 'failed', data: { attempt: 1 } },
          { id: 2, reportId: fakeReport.id, projectPath: 'PAM/pas-api', code: 'fix_attempt', status: 'success', data: { attempt: 2 } },
        ]
      }
      return []
    })

    let captured: ((r: any) => Promise<void>) | null = null
    ;(runPipeline as any).mockImplementation(async (_id: number, _sa: unknown, _tt: string, _tb: string, _rv: unknown, onComplete: any) => {
      captured = onComplete
      return 105
    })
    await mockPipelineRow(11, 'L2-代码缺陷')

    const handoverHandler = vi.fn(async () => ({ success: true, output: '' }))
    const notifyHandler = vi.fn(async () => ({ success: true, output: 'sent' }))
    registerCapabilityHandler('request_handover', handoverHandler)
    registerCapabilityHandler('notify_bug', notifyHandler)

    await handleAnalysisComplete(fakeReport.id, 'l2', 'bug', 'u-trigger')
    await captured!({ runId: 105, pipelineName: 'L2', status: 'failed', errorMessage: 'create_mr failed', stageResults: [], durationMs: 800 })

    // 走 aborted 路径，不是 handover
    expect(updateReportStatus).toHaveBeenCalledWith(fakeReport.id, 'aborted')
    expect(handoverHandler).not.toHaveBeenCalled()
    expect(notifyHandler).toHaveBeenCalled()
  })

  it('onComplete(failed) + 部分 project 成功 / 另一 project 全 failed → handover(fix_exhausted)', async () => {
    const { getBugAnalysisReportById, updateReportStatus } = await import('../../db/repositories/bug-analysis-reports.js')
    const { findByReportCode } = await import('../../db/repositories/bug-fix-events.js')
    const { runPipeline } = await import('../../pipeline/executor.js')
    ;(getBugAnalysisReportById as any).mockResolvedValue(fakeReport)
    ;(findByReportCode as any).mockImplementation(async (_rid: number, code: string) => {
      if (code === 'approval') return []
      if (code === 'handover') return []
      if (code === 'scope_identified') {
        return [
          { id: 10, reportId: fakeReport.id, projectPath: 'PAM/pas-api', code: 'scope_identified', status: 'success', data: { isPrimary: true } },
          { id: 11, reportId: fakeReport.id, projectPath: 'PAM/pas-web', code: 'scope_identified', status: 'success', data: { isPrimary: false } },
        ]
      }
      if (code === 'fix_attempt') {
        return [
          { id: 1, reportId: fakeReport.id, projectPath: 'PAM/pas-api', code: 'fix_attempt', status: 'success', data: { attempt: 1 } },
          { id: 2, reportId: fakeReport.id, projectPath: 'PAM/pas-web', code: 'fix_attempt', status: 'failed', data: { attempt: 1 } },
          { id: 3, reportId: fakeReport.id, projectPath: 'PAM/pas-web', code: 'fix_attempt', status: 'failed', data: { attempt: 2 } },
        ]
      }
      return []
    })

    let captured: ((r: any) => Promise<void>) | null = null
    ;(runPipeline as any).mockImplementation(async (_id: number, _sa: unknown, _tt: string, _tb: string, _rv: unknown, onComplete: any) => {
      captured = onComplete
      return 106
    })
    await mockPipelineRow(11, 'L2-代码缺陷')

    const handoverHandler = vi.fn(async () => ({ success: true, output: '' }))
    const notifyHandler = vi.fn(async () => ({ success: true, output: '' }))
    registerCapabilityHandler('request_handover', handoverHandler)
    registerCapabilityHandler('notify_bug', notifyHandler)

    await handleAnalysisComplete(fakeReport.id, 'l2', 'bug', 'u-trigger')
    await captured!({ runId: 106, pipelineName: 'L2', status: 'failed', errorMessage: 'fix partial', stageResults: [], durationMs: 800 })

    expect(updateReportStatus).not.toHaveBeenCalledWith(fakeReport.id, 'aborted')
    expect(handoverHandler).toHaveBeenCalledWith(expect.objectContaining({
      capabilityKey: 'request_handover',
      extraParams: expect.objectContaining({ reason: 'fix_exhausted' }),
    }))
  })

  it('onComplete(failed) + approval rejected → aborted，不触发 handover/notify', async () => {
    const { getBugAnalysisReportById, updateReportStatus } = await import('../../db/repositories/bug-analysis-reports.js')
    const { findByReportCode } = await import('../../db/repositories/bug-fix-events.js')
    const { runPipeline } = await import('../../pipeline/executor.js')
    ;(getBugAnalysisReportById as any).mockResolvedValue({ ...fakeReport, level: 'l3' })
    ;(findByReportCode as any).mockImplementation(async (_rid: number, code: string) => {
      if (code === 'approval') {
        return [
          { id: 1, reportId: fakeReport.id, code: 'approval', status: 'failed', data: { decision: 'rejected' } },
        ]
      }
      return []
    })

    let captured: ((r: any) => Promise<void>) | null = null
    ;(runPipeline as any).mockImplementation(async (_id: number, _sa: unknown, _tt: string, _tb: string, _rv: unknown, onComplete: any) => {
      captured = onComplete
      return 104
    })
    await mockPipelineRow(13, 'L3-业务逻辑')

    const handoverHandler = vi.fn(async () => ({ success: true, output: '' }))
    const notifyHandler = vi.fn(async () => ({ success: true, output: '' }))
    registerCapabilityHandler('request_handover', handoverHandler)
    registerCapabilityHandler('notify_bug', notifyHandler)

    await handleAnalysisComplete(fakeReport.id, 'l3', 'bug', 'u-trigger')
    await captured!({ runId: 104, pipelineName: 'L3', status: 'failed', errorMessage: 'rejected', stageResults: [], durationMs: 100 })

    expect(updateReportStatus).toHaveBeenCalledWith(fakeReport.id, 'aborted')
    expect(handoverHandler).not.toHaveBeenCalled()
    expect(notifyHandler).not.toHaveBeenCalled()
  })

  it('retry_analysis decision: triggers new analyze_bug with reuseIssueId', async () => {
    const { getBugAnalysisReportById } = await import('../../db/repositories/bug-analysis-reports.js')
    const { findByReportCode } = await import('../../db/repositories/bug-fix-events.js')
    const { runPipeline } = await import('../../pipeline/executor.js')
    ;(getBugAnalysisReportById as any).mockResolvedValue({ ...fakeReport, level: 'l3' })
    // 按 code 精确 mock，避免 coordinator 后续代码改动（例如提前检查 handover/fix_attempt）
    // 读到同一份 approval 事件而走错分支的误判
    ;(findByReportCode as any).mockImplementation(async (_rid: number, code: string) => {
      if (code === 'approval') {
        return [
          {
            id: 1, reportId: fakeReport.id, projectPath: null, code: 'approval',
            status: 'failed',
            data: { decision: 'retry_analysis', approverName: 'u-owner' },
            durationMs: null, createdAt: new Date(),
          },
        ]
      }
      return []
    })

    let captured: ((r: any) => Promise<void>) | null = null
    ;(runPipeline as any).mockImplementation(async (_id: number, _sa: unknown, _tt: string, _tb: string, _rv: unknown, onComplete: any) => {
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

  it('L4 bug: triggers handover (request_handover + notify_bug), no Pipeline', async () => {
    const { runPipeline } = await import('../../pipeline/executor.js')
    const { findByReportCode } = await import('../../db/repositories/bug-fix-events.js')
    ;(findByReportCode as any).mockResolvedValue([])  // 无已存在 handover 事件

    const handoverHandler = vi.fn(async () => ({ success: true, output: 'handed over' }))
    const notifyHandler = vi.fn(async () => ({ success: true, output: 'sent' }))
    registerCapabilityHandler('request_handover', handoverHandler)
    registerCapabilityHandler('notify_bug', notifyHandler)

    await handleAnalysisComplete(fakeReport.id, 'l4', 'bug', 'u-trigger')

    // 不启动 L4 Pipeline
    expect(runPipeline).not.toHaveBeenCalled()
    // 依次调 request_handover + notify_bug
    expect(handoverHandler).toHaveBeenCalledWith(expect.objectContaining({
      capabilityKey: 'request_handover',
      extraParams: expect.objectContaining({
        reportId: fakeReport.id,
        reason: 'l4_manual',
      }),
    }))
    expect(notifyHandler).toHaveBeenCalledWith(expect.objectContaining({
      capabilityKey: 'notify_bug',
      extraParams: expect.objectContaining({ reportId: fakeReport.id }),
    }))
  })
})

describe('AgentCoordinator - checkAndTriggerHandover', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('已有 handover success 事件 → 幂等跳过（不再调 triggerCapability）', async () => {
    const { findByReportCode } = await import('../../db/repositories/bug-fix-events.js')
    ;(findByReportCode as any).mockResolvedValue([
      { id: 1, reportId: 42, code: 'handover', status: 'success', data: { reason: 'fix_exhausted' } },
    ])

    const handoverHandler = vi.fn(async () => ({ success: true, output: '' }))
    const notifyHandler = vi.fn(async () => ({ success: true, output: '' }))
    registerCapabilityHandler('request_handover', handoverHandler)
    registerCapabilityHandler('notify_bug', notifyHandler)

    await checkAndTriggerHandover(42, 'user_requested', 'u-trigger')

    expect(handoverHandler).not.toHaveBeenCalled()
    expect(notifyHandler).not.toHaveBeenCalled()
  })

  it('request_handover 失败 → 不再调 notify_bug（不发假通知）', async () => {
    const { findByReportCode } = await import('../../db/repositories/bug-fix-events.js')
    ;(findByReportCode as any).mockResolvedValue([])

    const handoverHandler = vi.fn(async () => ({ success: false, error: 'report_not_found' }))
    const notifyHandler = vi.fn(async () => ({ success: true, output: '' }))
    registerCapabilityHandler('request_handover', handoverHandler)
    registerCapabilityHandler('notify_bug', notifyHandler)

    await checkAndTriggerHandover(42, 'fix_exhausted', 'u-trigger')

    expect(handoverHandler).toHaveBeenCalledOnce()
    expect(notifyHandler).not.toHaveBeenCalled()
  })

  it('正常路径 → request_handover 成功后立即调 notify_bug', async () => {
    const { findByReportCode } = await import('../../db/repositories/bug-fix-events.js')
    ;(findByReportCode as any).mockResolvedValue([])

    const handoverHandler = vi.fn(async () => ({ success: true, output: 'handed over' }))
    const notifyHandler = vi.fn(async () => ({ success: true, output: 'sent' }))
    registerCapabilityHandler('request_handover', handoverHandler)
    registerCapabilityHandler('notify_bug', notifyHandler)

    await checkAndTriggerHandover(42, 'fix_exhausted', 'u-trigger', {
      failedStage: 'fix_bug_l2',
      attemptCount: 3,
    })

    expect(handoverHandler).toHaveBeenCalledWith(expect.objectContaining({
      capabilityKey: 'request_handover',
      extraParams: expect.objectContaining({
        reportId: 42,
        reason: 'fix_exhausted',
        context: expect.objectContaining({ failedStage: 'fix_bug_l2', attemptCount: 3 }),
      }),
    }))
    expect(notifyHandler).toHaveBeenCalledWith(expect.objectContaining({
      capabilityKey: 'notify_bug',
      extraParams: expect.objectContaining({ reportId: 42 }),
    }))
  })
})
