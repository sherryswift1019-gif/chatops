import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  triggerCapability,
  registerCapabilityHandler,
} from '../../agent/coordinator.js'
import type { TaskContext } from '../../agent/tools/types.js'

// 必须在 import coordinator 之前 mock 掉所有依赖 —— vi.mock 会被 hoist 到顶部，
// 但本地 const 引用在 mock factory 内部不能用，所以下面一律用 import().then 模式。
vi.mock('../../db/repositories/capabilities.js', () => ({
  getCapabilityByKey: vi.fn(async (key: string) => ({
    id: 1,
    key,
    toolNames: [],
    systemPrompt: '',
  })),
}))

vi.mock('../../db/repositories/im-triggers.js', () => ({
  getIMTrigger: vi.fn(async () => null),
}))

vi.mock('../../db/repositories/bug-analysis-reports.js', () => ({
  setPipelineRunId: vi.fn(),
  updateReportStatus: vi.fn(),
  getBugAnalysisReportById: vi.fn(),
}))

vi.mock('../../db/repositories/bug-fix-events.js', () => ({
  findByReportCode: vi.fn(async () => []),
}))

vi.mock('../../db/repositories/projects-repo.js', () => ({
  getProjectByGitlabPath: vi.fn(),
}))

vi.mock('../../db/repositories/internal-capability-pipelines.js', () => ({
  getInternalPipelineId: vi.fn(async () => null),
}))

vi.mock('../../db/repositories/pipeline-bindings.js', () => ({
  resolvePipelineForTrigger: vi.fn(async () => null),
}))

vi.mock('../../pipeline/executor.js', () => ({
  runPipeline: vi.fn(),
  imTrigger: (a: unknown) => a,
  manualTrigger: (a: unknown) => a,
  apiTrigger: (a: unknown) => a,
  scheduledTrigger: (a: unknown) => a,
}))

vi.mock('../../db/client.js', () => ({
  getPool: vi.fn(() => ({ query: vi.fn() })),
}))

vi.mock('../../db/repositories/capability-invocations.js', () => ({
  createInvocation: vi.fn(),
  finishInvocation: vi.fn(),
}))

const ctx: TaskContext = {
  taskId: 't-inv',
  groupId: 'g1',
  platform: 'dingtalk',
  initiatorId: 'u1',
  initiatorRole: 'developer',
}

describe('AgentCoordinator - capability_invocations 日志', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    const mod = await import('../../db/repositories/capability-invocations.js')
    ;(mod.createInvocation as any).mockResolvedValue({ id: 999 })
    ;(mod.finishInvocation as any).mockResolvedValue(undefined)
  })

  it('顶层 handler 成功调用：createInvocation + finishInvocation(success)', async () => {
    const { createInvocation, finishInvocation } = await import(
      '../../db/repositories/capability-invocations.js'
    )
    registerCapabilityHandler('cap_a', async () => ({
      success: true,
      output: 'ok',
    }))

    const result = await triggerCapability({
      capabilityKey: 'cap_a',
      context: ctx,
      extraParams: { foo: 'bar' },
    })

    expect(result.success).toBe(true)
    expect(createInvocation).toHaveBeenCalledOnce()
    expect(createInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilityKey: 'cap_a',
        triggerType: 'im',
        platform: 'dingtalk',
        groupId: 'g1',
        triggeredBy: 'u1',
        taskId: 't-inv',
        params: { foo: 'bar' },
      }),
    )
    expect(finishInvocation).toHaveBeenCalledWith(999, 'success', 'ok', '')
  })

  it('handler 返回 success: false → finishInvocation(failed, error)', async () => {
    const { finishInvocation } = await import(
      '../../db/repositories/capability-invocations.js'
    )
    registerCapabilityHandler('cap_b', async () => ({
      success: false,
      error: 'soft fail',
    }))

    const result = await triggerCapability({
      capabilityKey: 'cap_b',
      context: ctx,
    })

    expect(result.success).toBe(false)
    expect(finishInvocation).toHaveBeenCalledWith(999, 'failed', '', 'soft fail')
  })

  it('handler 抛异常 → finishInvocation(failed, err.message)', async () => {
    const { finishInvocation } = await import(
      '../../db/repositories/capability-invocations.js'
    )
    registerCapabilityHandler('cap_c', async () => {
      throw new Error('boom')
    })

    const result = await triggerCapability({
      capabilityKey: 'cap_c',
      context: ctx,
    })

    expect(result.success).toBe(false)
    expect(finishInvocation).toHaveBeenCalledWith(999, 'failed', '', 'boom')
  })

  it('_suppressInvocationLog: true → 不写 capability_invocations', async () => {
    const { createInvocation, finishInvocation } = await import(
      '../../db/repositories/capability-invocations.js'
    )
    registerCapabilityHandler('cap_d', async () => ({
      success: true,
      output: 'ok',
    }))

    const result = await triggerCapability({
      capabilityKey: 'cap_d',
      context: ctx,
      _suppressInvocationLog: true,
    })

    expect(result.success).toBe(true)
    expect(createInvocation).not.toHaveBeenCalled()
    expect(finishInvocation).not.toHaveBeenCalled()
  })

  it('inferTriggerType：dingtalk/feishu → im, test/e2e/api → api, 其他 → manual', async () => {
    const { createInvocation } = await import(
      '../../db/repositories/capability-invocations.js'
    )
    registerCapabilityHandler('cap_e', async () => ({
      success: true,
      output: '',
    }))

    const cases: Array<{ platform: string; expected: string }> = [
      { platform: 'dingtalk', expected: 'im' },
      { platform: 'feishu', expected: 'im' },
      { platform: 'test', expected: 'api' },
      { platform: 'e2e', expected: 'api' },
      { platform: 'api', expected: 'api' },
      { platform: 'admin', expected: 'manual' },
      { platform: '', expected: 'manual' },
    ]

    for (const c of cases) {
      ;(createInvocation as any).mockClear()
      await triggerCapability({
        capabilityKey: 'cap_e',
        context: { ...ctx, platform: c.platform },
      })
      expect(createInvocation).toHaveBeenCalledWith(
        expect.objectContaining({ triggerType: c.expected }),
      )
    }
  })

  it('createInvocation 失败 → handler 仍执行，结果照常返回（不阻塞业务）', async () => {
    const { createInvocation, finishInvocation } = await import(
      '../../db/repositories/capability-invocations.js'
    )
    ;(createInvocation as any).mockRejectedValueOnce(new Error('db down'))

    const handler = vi.fn(async () => ({ success: true, output: 'still ran' }))
    registerCapabilityHandler('cap_f', handler)

    const result = await triggerCapability({
      capabilityKey: 'cap_f',
      context: ctx,
    })

    expect(handler).toHaveBeenCalledOnce()
    expect(result.success).toBe(true)
    expect(result.output).toBe('still ran')
    // createInvocation 失败 → invocationId 为 null → 不会调 finishInvocation
    expect(finishInvocation).not.toHaveBeenCalled()
  })
})
