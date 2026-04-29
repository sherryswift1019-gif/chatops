import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { StageDefinition, StageContext } from '../../pipeline/types.js'

const { setupSpy, teardownSpy, triggerSpy, porygonRunSpy } = vi.hoisted(() => ({
  setupSpy: vi.fn(),
  teardownSpy: vi.fn(),
  triggerSpy: vi.fn(),
  porygonRunSpy: vi.fn(),
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

vi.mock('@snack-kit/porygon', () => ({
  createPorygon: () => ({ run: porygonRunSpy, query: vi.fn() }),
}))

vi.mock('../../agent/claude-config.js', () => ({
  buildClaudeEnv: async () => ({ CLAUDE_CODE_OAUTH_TOKEN: 'fake' }),
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

describe('runCustomAgent container + MCP', () => {
  const customStage: StageDefinition = {
    name: 'cust',
    stageType: 'llm_agent',
    customPrompt: 'do X',
    containerImage: 'python:3.11',
    allowedTools: ['mcp__chatops__run_command'],
    timeoutSeconds: 60,
    retryCount: 0,
    onFailure: 'stop',
  } as StageDefinition

  beforeEach(() => {
    setupSpy.mockReset()
    teardownSpy.mockReset()
    porygonRunSpy.mockReset()
    setupSpy.mockResolvedValue(undefined)
    teardownSpy.mockResolvedValue(undefined)
  })

  it('always injects chatops mcpServer + dockerContainerName in CHATOPS_TASK_CONTEXT env', async () => {
    porygonRunSpy.mockResolvedValue('done')
    const hooks = buildDefaultHooks('/tmp/log')
    const r = await hooks.runCustomAgent!(customStage, ctxBase)
    expect(setupSpy).toHaveBeenCalled()
    const [runOpts] = porygonRunSpy.mock.calls[0]
    expect(runOpts.mcpServers).toHaveProperty('chatops')
    expect(runOpts.onlyTools).toEqual(['mcp__chatops__run_command'])
    const tc = JSON.parse(runOpts.envVars.CHATOPS_TASK_CONTEXT)
    expect(tc.dockerContainerName).toBe(`chatops-cust-${ctxBase.runId}-${ctxBase.stageIndex}`)
    expect(teardownSpy).toHaveBeenCalled()
    expect(r.status).toBe('success')
  })

  it('without containerImage: still injects chatops mcpServer; no dockerContainerName', async () => {
    porygonRunSpy.mockResolvedValue('ok')
    const hooks = buildDefaultHooks('/tmp/log')
    await hooks.runCustomAgent!(
      { ...customStage, containerImage: undefined },
      { ...ctxBase, pipelineContainerImage: undefined } as StageContext,
    )
    const [runOpts] = porygonRunSpy.mock.calls[0]
    expect(runOpts.mcpServers).toHaveProperty('chatops')
    const tc = JSON.parse(runOpts.envVars.CHATOPS_TASK_CONTEXT)
    expect(tc.dockerContainerName).toBeUndefined()
    expect(setupSpy).not.toHaveBeenCalled()
  })

  it('teardown called even if porygon throws', async () => {
    porygonRunSpy.mockRejectedValue(new Error('claude crashed'))
    const hooks = buildDefaultHooks('/tmp/log')
    const r = await hooks.runCustomAgent!(customStage, ctxBase)
    expect(teardownSpy).toHaveBeenCalled()
    expect(r.status).toBe('failed')
  })
})
