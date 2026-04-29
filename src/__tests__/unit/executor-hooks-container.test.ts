import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { StageDefinition, StageContext } from '../../pipeline/types.js'

const { setupSpy, teardownSpy, triggerSpy } = vi.hoisted(() => ({
  setupSpy: vi.fn(),
  teardownSpy: vi.fn(),
  triggerSpy: vi.fn(),
}))

vi.mock('../../pipeline/executors/docker.js', () => ({
  DockerExecutor: class FakeDocker {
    constructor(public image: string) {}
    setup = setupSpy
    teardown = teardownSpy
    exec = vi.fn()
  },
}))

vi.mock('../../agent/coordinator.js', () => ({
  triggerCapability: triggerSpy,
}))

import { buildDefaultHooks } from '../../pipeline/executor-hooks.js'

const stage: StageDefinition = {
  name: 's1',
  stageType: 'llm_agent',
  capabilityKey: 'analyze_bug',
  containerImage: 'node:18',
  timeoutSeconds: 60,
  retryCount: 0,
  onFailure: 'stop',
} as StageDefinition

const ctxBase = {
  runId: 42,
  stageIndex: 0,
  servers: {},
  logDir: '/tmp/log',
  pipelineContainerImage: 'fallback:latest',
} as unknown as StageContext

describe('runCapability container lifecycle', () => {
  beforeEach(() => {
    setupSpy.mockReset()
    teardownSpy.mockReset()
    triggerSpy.mockReset()
    setupSpy.mockResolvedValue(undefined)
    teardownSpy.mockResolvedValue(undefined)
  })

  it('starts container when stage.containerImage set, injects dockerContainerName, tears down', async () => {
    triggerSpy.mockResolvedValue({ success: true, output: 'done' })
    const hooks = buildDefaultHooks('/tmp/log')
    const r = await hooks.runCapability!(stage, ctxBase)
    expect(setupSpy).toHaveBeenCalled()
    const [containerName] = setupSpy.mock.calls[0]
    expect(containerName).toMatch(/^chatops-cap-42-0$/)
    const callArg = triggerSpy.mock.calls[0][0]
    expect(callArg.context.dockerContainerName).toBe('chatops-cap-42-0')
    expect(teardownSpy).toHaveBeenCalled()
    expect(r.status).toBe('success')
  })

  it('falls back to pipelineContainerImage when stage.containerImage empty', async () => {
    triggerSpy.mockResolvedValue({ success: true, output: 'ok' })
    const hooks = buildDefaultHooks('/tmp/log')
    await hooks.runCapability!({ ...stage, containerImage: undefined }, ctxBase)
    expect(setupSpy).toHaveBeenCalled()
  })

  it('no image at all: does not call setup/teardown', async () => {
    triggerSpy.mockResolvedValue({ success: true, output: 'ok' })
    const hooks = buildDefaultHooks('/tmp/log')
    await hooks.runCapability!(
      { ...stage, containerImage: undefined },
      { ...ctxBase, pipelineContainerImage: undefined } as StageContext,
    )
    expect(setupSpy).not.toHaveBeenCalled()
    expect(teardownSpy).not.toHaveBeenCalled()
    const callArg = triggerSpy.mock.calls[0][0]
    expect(callArg.context.dockerContainerName).toBeUndefined()
  })

  it('teardown called even if triggerCapability throws', async () => {
    triggerSpy.mockRejectedValue(new Error('boom'))
    const hooks = buildDefaultHooks('/tmp/log')
    const r = await hooks.runCapability!(stage, ctxBase)
    expect(teardownSpy).toHaveBeenCalled()
    expect(r.status).toBe('failed')
  })
})
