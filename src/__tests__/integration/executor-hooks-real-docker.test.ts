import { describe, it, expect, vi } from 'vitest'
import { execSync } from 'child_process'

const { triggerSpy } = vi.hoisted(() => ({ triggerSpy: vi.fn() }))
vi.mock('../../agent/coordinator.js', () => ({ triggerCapability: triggerSpy }))

import { buildDefaultHooks } from '../../pipeline/executor-hooks.js'
import type { StageDefinition, StageContext } from '../../pipeline/types.js'

const hasDocker = (() => {
  try { execSync('docker version --format ok', { stdio: 'pipe' }); return true } catch { return false }
})()

describe.skipIf(!hasDocker)('runCapability with real docker', () => {
  it('creates container, exposes name in ctx, removes after run', async () => {
    let observedContainer: string | undefined
    triggerSpy.mockImplementation(async (call: { context: { dockerContainerName?: string } }) => {
      observedContainer = call.context.dockerContainerName
      // 在容器存在期间断言 docker ps 能看到
      const ps = execSync(`docker ps --filter name=^/${observedContainer}$ --format '{{.Names}}'`, { stdio: 'pipe' }).toString().trim()
      expect(ps).toBe(observedContainer)
      return { success: true, output: 'ok' }
    })

    const stage: StageDefinition = {
      name: 's', stageType: 'llm_agent',
      capabilityKey: 'analyze_bug',
      containerImage: 'alpine:3.19',
      timeoutSeconds: 60, retryCount: 0, onFailure: 'stop',
    } as StageDefinition

    const ctx = { runId: Date.now(), stageIndex: 0, servers: {}, logDir: '/tmp/log' } as unknown as StageContext

    const hooks = buildDefaultHooks('/tmp/log')
    const r = await hooks.runCapability!(stage, ctx)
    expect(r.status).toBe('success')
    expect(observedContainer).toMatch(/^chatops-cap-/)

    // teardown 应该已删容器
    const after = execSync(`docker ps -a --filter name=^/${observedContainer}$ --format '{{.Names}}'`, { stdio: 'pipe' }).toString().trim()
    expect(after).toBe('')
  }, 90_000)
})
