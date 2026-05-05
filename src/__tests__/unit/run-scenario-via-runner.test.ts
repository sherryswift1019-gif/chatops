// src/__tests__/unit/run-scenario-via-runner.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { PipelineBStateType } from '../../e2e/pipeline-b/types.js'
import type { Manifest } from '../../e2e/pipeline-b/playbook/manifest.js'
import type { Playbook } from '../../e2e/pipeline-b/playbook/types.js'

vi.mock('../../db/repositories/e2e-scenario-runs.js', () => ({
  createScenarioRun: vi.fn(),
  finishScenarioRun: vi.fn(),
  getLatestAttemptNumber: vi.fn(),
}))

vi.mock('../../db/repositories/e2e-runs.js', () => ({
  updateE2eRunStatus: vi.fn(),
}))

vi.mock('../../agent/e2e-scenario/runner.js', () => ({
  runE2eScenario: vi.fn(),
}))

vi.mock('../../e2e/pipeline-b/evidence/storage.js', () => ({
  persistEvidenceDir: vi.fn().mockResolvedValue({
    persistedDir: '/var/chatops/e2e-evidence/1/login.success/1',
    evidenceDirUri: '/admin/e2e-runs/1/evidence/login.success/1',
  }),
}))

vi.mock('../../e2e/pipeline-b/im-notifier.js', () => ({
  notifyScenarioFailed: vi.fn().mockResolvedValue(undefined),
}))

const { runScenarioNode } = await import('../../e2e/pipeline-b/nodes/run-scenario.js')
const { createScenarioRun, finishScenarioRun, getLatestAttemptNumber } = await import(
  '../../db/repositories/e2e-scenario-runs.js'
)
const { updateE2eRunStatus } = await import('../../db/repositories/e2e-runs.js')
const { runE2eScenario } = await import('../../agent/e2e-scenario/runner.js')
const { notifyScenarioFailed } = await import('../../e2e/pipeline-b/im-notifier.js')

const PLAYBOOK: Playbook = {
  specPath: 'docs/test-playbooks/login.playbook.yaml',
  scenarios: [
    {
      id: 'login.success',
      name: '登录成功',
      tags: [],
      steps: [],
      acceptance: [{ kind: 'url_match', value: '/dashboard' }],
    },
  ],
}

const PASS_MANIFEST: Manifest = {
  scenarioId: 'login.success',
  attemptNumber: 1,
  result: 'pass',
  startedAt: '2026-05-05T10:00:00.000Z',
  finishedAt: '2026-05-05T10:00:30.000Z',
  durationMs: 30000,
  claudeTrace: [],
  acceptanceResults: [{ kind: 'url_match', index: 0, result: 'pass' }],
  artifacts: [],
}

function makeState(overrides: Partial<PipelineBStateType> = {}): PipelineBStateType {
  return {
    runId: 1n,
    sandboxId: null,
    targetProjectId: 'chatops',
    sourceBranch: 'main',
    iterationBranch: '',
    scenarioFilter: null,
    sandboxHandle: {
      envId: 'env-1',
      kind: 'docker-compose-local',
      endpoints: { web_base_url: 'http://localhost:3000' },
      internalRefs: {},
      containerId: 'sandbox-abc',
      workdir: '/app',
    },
    projectScripts: { build: 'build.sh', deploy: 'deploy.sh', test: 'test.sh' },
    pendingScenarios: [],
    currentScenario: { id: 'login.success', name: '登录成功', tags: [] },
    currentScenarioRunId: null,
    lastScenarioResult: null,
    lastFixResult: null,
    evidenceDirTemp: null,
    humanReviewDecision: null,
    currentManifest: null,
    playbooks: { 'docs/test-playbooks/login.playbook.yaml': PLAYBOOK },
    governorState: {
      perScenarioAttempts: {},
      totalAttempts: 0,
      runStartedAt: 0,
      totalElapsedMs: 0,
      limits: { maxPerScenarioAttempts: 3, maxRunHours: 4, maxTotalAttempts: 30, maxQueuedRuns: 2 },
    },
    summaryMrUrl: null,
    errorMessage: null,
    imContext: null,
    ...overrides,
  } as PipelineBStateType
}

describe('runScenarioNode (playbook-driven)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getLatestAttemptNumber).mockResolvedValue(0)
    vi.mocked(createScenarioRun).mockResolvedValue({
      id: 100n,
      e2eRunId: 1n,
      scenarioId: 'login.success',
      scenarioName: '登录成功',
      attemptNumber: 1,
    } as never)
    vi.mocked(finishScenarioRun).mockResolvedValue(undefined)
    vi.mocked(updateE2eRunStatus).mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('happy path: pass → finishScenarioRun(pass)，currentManifest 写 state，不通知失败', async () => {
    vi.mocked(runE2eScenario).mockResolvedValue({
      manifest: PASS_MANIFEST,
      rawOutput: 'ok',
      errorMessage: null,
    })

    const out = await runScenarioNode(makeState())
    expect(out.lastScenarioResult).toBe('pass')
    expect(out.currentManifest).toEqual(PASS_MANIFEST)
    expect(out.currentScenarioRunId).toBe(100n)
    expect(vi.mocked(finishScenarioRun)).toHaveBeenCalledWith(100n, 'pass', expect.objectContaining({
      durationMs: 30000,
      evidenceDirUri: '/admin/e2e-runs/1/evidence/login.success/1',
      evidenceManifest: expect.objectContaining({ scenarioId: 'login.success' }),
    }))
    expect(vi.mocked(notifyScenarioFailed)).not.toHaveBeenCalled()
  })

  it('runE2eScenario 调用入参正确（playbook + scenarioId + sandboxHandle + attemptNumber）', async () => {
    vi.mocked(runE2eScenario).mockResolvedValue({
      manifest: PASS_MANIFEST,
      rawOutput: '',
      errorMessage: null,
    })
    await runScenarioNode(makeState())
    expect(vi.mocked(runE2eScenario)).toHaveBeenCalledWith(
      expect.objectContaining({
        playbook: PLAYBOOK,
        scenarioId: 'login.success',
        attemptNumber: 1,
        sandboxHandle: expect.objectContaining({ containerId: 'sandbox-abc' }),
      }),
    )
  })

  it('manifest.result=fail → finishScenarioRun(fail)，imContext 时通知 IM 失败', async () => {
    const failManifest: Manifest = { ...PASS_MANIFEST, result: 'fail' }
    vi.mocked(runE2eScenario).mockResolvedValue({
      manifest: failManifest,
      rawOutput: '',
      errorMessage: null,
    })

    const adapter = { sendMessage: vi.fn().mockResolvedValue(undefined) } as never
    const state = makeState({ imContext: { adapter, groupId: 'g1', platform: 'dingtalk' } })
    const out = await runScenarioNode(state)
    expect(out.lastScenarioResult).toBe('fail')
    expect(vi.mocked(finishScenarioRun)).toHaveBeenCalledWith(100n, 'fail', expect.any(Object))
    expect(vi.mocked(notifyScenarioFailed)).toHaveBeenCalled()
  })

  it('runE2eScenario 写 manifest 失败 → result=error，仍 finishScenarioRun(error)', async () => {
    vi.mocked(runE2eScenario).mockResolvedValue({
      manifest: null,
      rawOutput: '',
      errorMessage: 'Claude timeout',
    })
    const out = await runScenarioNode(makeState())
    expect(out.lastScenarioResult).toBe('error')
    expect(out.currentManifest).toBeNull()
    expect(vi.mocked(finishScenarioRun)).toHaveBeenCalledWith(100n, 'error', expect.any(Object))
  })

  it('scenario 不在 playbooks 里 → 抛错', async () => {
    const state = makeState({ playbooks: {} })
    await expect(runScenarioNode(state)).rejects.toThrow(/找不到所属 playbook/)
  })

  it('sandboxHandle 为 null → 抛错', async () => {
    const state = makeState({ sandboxHandle: null })
    await expect(runScenarioNode(state)).rejects.toThrow(/sandboxHandle is null/)
  })

  it('governorState totalAttempts / perScenarioAttempts 递增', async () => {
    vi.mocked(runE2eScenario).mockResolvedValue({
      manifest: PASS_MANIFEST,
      rawOutput: '',
      errorMessage: null,
    })
    const state = makeState({
      governorState: {
        perScenarioAttempts: { 'login.success': 2 },
        totalAttempts: 5,
        runStartedAt: Date.now() - 1000,
        totalElapsedMs: 0,
        limits: { maxPerScenarioAttempts: 3, maxRunHours: 4, maxTotalAttempts: 30, maxQueuedRuns: 2 },
      },
    })
    const out = await runScenarioNode(state)
    expect(out.governorState?.totalAttempts).toBe(6)
    expect(out.governorState?.perScenarioAttempts['login.success']).toBe(3)
  })

  it('updateE2eRunStatus(running) 被调一次', async () => {
    vi.mocked(runE2eScenario).mockResolvedValue({
      manifest: PASS_MANIFEST,
      rawOutput: '',
      errorMessage: null,
    })
    await runScenarioNode(makeState())
    expect(vi.mocked(updateE2eRunStatus)).toHaveBeenCalledWith(1n, 'running')
  })
})
