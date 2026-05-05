// src/__tests__/unit/pipeline-b-nodes.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../e2e/pipeline-b/run-script.js', () => ({
  runScript: vi.fn(),
  parseLastJsonLine: vi.fn((text: string) => {
    const lines = text.trimEnd().split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim()
      if (line.startsWith('{')) {
        try { return JSON.parse(line) } catch { /* skip */ }
      }
    }
    return null
  }),
}))

vi.mock('../../db/repositories/e2e-target-projects.js', () => ({
  getE2eTargetProject: vi.fn(),
}))

vi.mock('../../db/repositories/e2e-runs.js', () => ({
  createE2eRun: vi.fn(),
  updateE2eRunStatus: vi.fn(),
}))

vi.mock('../../db/repositories/e2e-sandboxes.js', () => ({
  createSandbox: vi.fn(),
  updateSandboxStatus: vi.fn(),
  getSandboxByRunId: vi.fn(),
}))

vi.mock('../../db/repositories/e2e-scenario-runs.js', () => ({
  createScenarioRun: vi.fn(),
  finishScenarioRun: vi.fn(),
  getLatestAttemptNumber: vi.fn(),
}))

vi.mock('../../config/gitlab.js', () => ({
  resolveGitlabConfig: vi.fn(),
}))

// Mock fs so setup-sandbox's readFileSync can be controlled
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    writeFileSync: vi.fn(),
    mkdtempSync: vi.fn(() => '/tmp/e2e-mock-dir'),
    mkdirSync: vi.fn(),
  }
})

import { runScript } from '../../e2e/pipeline-b/run-script.js'
import { getE2eTargetProject } from '../../db/repositories/e2e-target-projects.js'
import { createSandbox, updateSandboxStatus } from '../../db/repositories/e2e-sandboxes.js'
import { updateE2eRunStatus } from '../../db/repositories/e2e-runs.js'
import { createScenarioRun, finishScenarioRun, getLatestAttemptNumber } from '../../db/repositories/e2e-scenario-runs.js'
import { resolveGitlabConfig } from '../../config/gitlab.js'
import * as fs from 'fs'

// 导入所有节点
import { setupSandboxNode } from '../../e2e/pipeline-b/nodes/setup-sandbox.js'
import { deployInitialNode } from '../../e2e/pipeline-b/nodes/deploy-initial.js'
import { teardownSandboxNode } from '../../e2e/pipeline-b/nodes/teardown-sandbox.js'
import { healthcheckNode } from '../../e2e/pipeline-b/nodes/healthcheck.js'
import { redeployNode } from '../../e2e/pipeline-b/nodes/redeploy.js'
import { discoverNode } from '../../e2e/pipeline-b/nodes/discover.js'
import { pickNextScenarioNode } from '../../e2e/pipeline-b/nodes/pick-next-scenario.js'
import { runScenarioNode } from '../../e2e/pipeline-b/nodes/run-scenario.js'
import { markGreenNode } from '../../e2e/pipeline-b/nodes/mark-green.js'
import { markUnfixableNode } from '../../e2e/pipeline-b/nodes/mark-unfixable.js'
import { createSummaryMrNode } from '../../e2e/pipeline-b/nodes/create-summary-mr.js'
import { finalizeFailedNode, governorCheck } from '../../e2e/pipeline-b/nodes/finalize-failed.js'
import { resetIterationBranchNode } from '../../e2e/pipeline-b/nodes/reset-iteration-branch.js'
import type { PipelineBStateType, GovernorState } from '../../e2e/pipeline-b/types.js'

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const PROJECT_MOCK = {
  id: 'chatops',
  displayName: 'ChatOps',
  gitlabRepo: 'devops/chatops',
  defaultBranch: 'main',
  workingDir: '/workspace/chatops',
  scripts: { build: 'build.sh', deploy: 'deploy.sh', test: 'test.sh' },
  capabilities: {},
  defaultSandboxKind: 'docker-compose-local',
  createdAt: new Date().toISOString(),
}

const SANDBOX_HANDLE = {
  envId: 'test-env-42',
  kind: 'docker-compose-local',
  endpoints: { api: 'http://localhost:13042' },
  internalRefs: {},
  containerId: 'abc123',
  workdir: '/workspace/chatops',
}

const DEFAULT_GOVERNOR: GovernorState = {
  perScenarioAttempts: {},
  totalElapsedMs: 0,
  totalAttempts: 0,
  runStartedAt: Date.now(),
  limits: {
    maxPerScenarioAttempts: 3,
    maxRunHours: 4,
    maxTotalAttempts: 30,
    maxQueuedRuns: 2,
  },
}

const BASE_STATE: PipelineBStateType = {
  runId: 42n,
  sandboxId: null,
  targetProjectId: 'chatops',
  sourceBranch: 'main',
  iterationBranch: 'test-iter/42',
  scenarioFilter: null,
  sandboxHandle: null,
  projectScripts: { build: 'build.sh', deploy: 'deploy.sh', test: 'test.sh' },
  pendingScenarios: [],
  currentScenario: null,
  currentScenarioRunId: null,
  lastScenarioResult: null,
  lastFixResult: null,
  evidenceDirTemp: null,
  humanReviewDecision: null,
  currentManifest: null,
  playbooks: {},
  governorState: DEFAULT_GOVERNOR,
  summaryMrUrl: null,
  errorMessage: null,
  imContext: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getE2eTargetProject).mockResolvedValue(PROJECT_MOCK as any)
  vi.mocked(createSandbox).mockResolvedValue({
    id: 1n,
    status: 'provisioning',
    handle: {},
    kind: 'docker-compose-local',
    createdAt: new Date(),
  } as any)
  vi.mocked(updateSandboxStatus).mockResolvedValue(undefined)
  vi.mocked(updateE2eRunStatus).mockResolvedValue(undefined)
  vi.mocked(createScenarioRun).mockResolvedValue({
    id: 100n,
    e2eRunId: 42n,
    scenarioId: 'login',
    attemptNumber: 1,
  } as any)
  vi.mocked(finishScenarioRun).mockResolvedValue(undefined)
  vi.mocked(getLatestAttemptNumber).mockResolvedValue(0)
  vi.mocked(resolveGitlabConfig).mockResolvedValue({
    url: 'https://gitlab.example.com',
    token: 'tok',
    skipTlsVerify: false,
  })
})

// ---------------------------------------------------------------------------
// setupSandboxNode
// ---------------------------------------------------------------------------

describe('setupSandboxNode', () => {
  it('provision 失败 → throws provision failed + updateE2eRunStatus called', async () => {
    vi.mocked(runScript).mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'no space left',
      parsed: null,
    })
    await expect(setupSandboxNode({ ...BASE_STATE })).rejects.toThrow('provision failed')
    expect(updateE2eRunStatus).toHaveBeenCalledWith(42n, 'failed', expect.any(Object))
  })

  it('project not found → throws', async () => {
    vi.mocked(getE2eTargetProject).mockResolvedValue(null)
    await expect(setupSandboxNode({ ...BASE_STATE })).rejects.toThrow('"chatops" not found')
  })

  it('provision 成功但 readFileSync 失败 → throws read handle file', async () => {
    vi.mocked(runScript).mockResolvedValueOnce({
      exitCode: 0,
      stdout: '',
      stderr: '',
      parsed: null,
    })
    // readFileSync throws because /tmp/e2e-mock-dir/handle.json does not exist
    vi.mocked(fs.readFileSync).mockImplementationOnce(() => {
      throw new Error('ENOENT: no such file')
    })
    await expect(setupSandboxNode({ ...BASE_STATE })).rejects.toThrow('read handle file')
  })

  it('provision 成功 + handle 文件可读 → sandboxId 写入 + sandboxHandle 非空', async () => {
    const handleData = {
      envId: 'test-env-42',
      kind: 'docker-compose-local',
      endpoints: { api: 'http://localhost:13042' },
      internalRefs: {},
    }
    vi.mocked(runScript).mockResolvedValueOnce({
      exitCode: 0,
      stdout: '',
      stderr: '',
      parsed: null,
    })
    vi.mocked(fs.readFileSync).mockReturnValueOnce(JSON.stringify(handleData) as any)

    const result = await setupSandboxNode({ ...BASE_STATE })
    expect(result.sandboxId).toBe(1n)
    expect(result.sandboxHandle).toMatchObject({ envId: 'test-env-42', kind: 'docker-compose-local' })
    expect(createSandbox).toHaveBeenCalled()
    expect(updateSandboxStatus).toHaveBeenCalledWith(1n, 'ready', expect.any(Object))
  })
})

// ---------------------------------------------------------------------------
// deployInitialNode
// ---------------------------------------------------------------------------

describe('deployInitialNode', () => {
  it('sandboxHandle null → throws', async () => {
    await expect(deployInitialNode({ ...BASE_STATE })).rejects.toThrow('sandboxHandle is null')
  })

  it('build 成功 + deploy 成功 → returns empty patch', async () => {
    vi.mocked(runScript)
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '', parsed: null }) // build
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '', parsed: null }) // deploy
    const result = await deployInitialNode({ ...BASE_STATE, sandboxHandle: SANDBOX_HANDLE })
    expect(result).toEqual({})
  })

  it('build 失败 → throws build failed', async () => {
    vi.mocked(runScript).mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'build error',
      parsed: null,
    })
    await expect(
      deployInitialNode({ ...BASE_STATE, sandboxHandle: SANDBOX_HANDLE }),
    ).rejects.toThrow('build failed')
  })

  it('deploy 失败 → throws deploy failed', async () => {
    vi.mocked(runScript)
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '', parsed: null }) // build ok
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'deploy err', parsed: null }) // deploy fail
    await expect(
      deployInitialNode({ ...BASE_STATE, sandboxHandle: SANDBOX_HANDLE }),
    ).rejects.toThrow('deploy failed')
  })
})

// ---------------------------------------------------------------------------
// teardownSandboxNode
// ---------------------------------------------------------------------------

describe('teardownSandboxNode', () => {
  it('no sandboxHandle → returns {} without calling runScript', async () => {
    const result = await teardownSandboxNode({ ...BASE_STATE })
    expect(result).toEqual({})
    expect(runScript).not.toHaveBeenCalled()
  })

  it('teardown 成功 → sandboxHandle 清空 + updateSandboxStatus called', async () => {
    vi.mocked(runScript).mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '', parsed: null })
    const result = await teardownSandboxNode({
      ...BASE_STATE,
      sandboxHandle: SANDBOX_HANDLE,
      sandboxId: 1n,
    })
    expect(result.sandboxHandle).toBeNull()
    expect(updateSandboxStatus).toHaveBeenCalledWith(1n, 'torn_down', expect.any(Object))
  })

  it('teardown 非 0 exit → 依然清空 sandboxHandle (幂等)', async () => {
    vi.mocked(runScript).mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'already down',
      parsed: null,
    })
    const result = await teardownSandboxNode({
      ...BASE_STATE,
      sandboxHandle: SANDBOX_HANDLE,
      sandboxId: 1n,
    })
    expect(result.sandboxHandle).toBeNull()
  })

  it('project not found → sandboxHandle 清空 (graceful)', async () => {
    vi.mocked(getE2eTargetProject).mockResolvedValue(null)
    const result = await teardownSandboxNode({
      ...BASE_STATE,
      sandboxHandle: SANDBOX_HANDLE,
    })
    expect(result.sandboxHandle).toBeNull()
    expect(runScript).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// healthcheckNode
// ---------------------------------------------------------------------------

describe('healthcheckNode', () => {
  it('sandboxHandle null → throws', async () => {
    await expect(healthcheckNode({ ...BASE_STATE })).rejects.toThrow('sandboxHandle is null')
  })

  it('exit 0 → returns empty patch', async () => {
    vi.mocked(runScript).mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '', parsed: null })
    const result = await healthcheckNode({ ...BASE_STATE, sandboxHandle: SANDBOX_HANDLE })
    expect(result).toEqual({})
  })

  it('exit 非 0 → throws not healthy', async () => {
    vi.mocked(runScript).mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'unhealthy',
      parsed: null,
    })
    await expect(
      healthcheckNode({ ...BASE_STATE, sandboxHandle: SANDBOX_HANDLE }),
    ).rejects.toThrow('not healthy')
  })
})

// ---------------------------------------------------------------------------
// redeployNode
// ---------------------------------------------------------------------------

describe('redeployNode', () => {
  it('sandboxHandle null → throws', async () => {
    await expect(redeployNode({ ...BASE_STATE })).rejects.toThrow('sandboxHandle is null')
  })

  it('redeploy 成功 → status 更新为 ready', async () => {
    vi.mocked(runScript).mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '', parsed: null })
    const result = await redeployNode({
      ...BASE_STATE,
      sandboxHandle: SANDBOX_HANDLE,
      sandboxId: 1n,
    })
    expect(result).toEqual({})
    // redeploying then ready
    expect(updateSandboxStatus).toHaveBeenLastCalledWith(1n, 'ready')
  })

  it('redeploy 失败 → throws + sandbox status=failed', async () => {
    vi.mocked(runScript).mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'OOM',
      parsed: null,
    })
    await expect(
      redeployNode({ ...BASE_STATE, sandboxHandle: SANDBOX_HANDLE, sandboxId: 1n }),
    ).rejects.toThrow('redeploy: failed')
    expect(updateSandboxStatus).toHaveBeenLastCalledWith(1n, 'failed')
  })
})

// ---------------------------------------------------------------------------
// discoverNode
// ---------------------------------------------------------------------------

describe('discoverNode', () => {
  it('exit 非 0 → throws --discover failed', async () => {
    vi.mocked(runScript).mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'no tests',
      parsed: null,
    })
    await expect(discoverNode({ ...BASE_STATE })).rejects.toThrow('--discover failed')
  })

  it('--discover 成功 → pendingScenarios 设置', async () => {
    const scenarios = [
      { id: 'login-success', name: 'Login', tags: ['smoke'] },
      { id: 'create-prd', name: 'Create PRD', tags: ['core'] },
    ]
    vi.mocked(runScript).mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify({ scenarios }),
      stderr: '',
      parsed: { scenarios },
    })
    const result = await discoverNode({ ...BASE_STATE })
    expect(result.pendingScenarios).toHaveLength(2)
  })

  it('tag filter 生效', async () => {
    const scenarios = [
      { id: 'login-success', name: 'Login', tags: ['smoke'] },
      { id: 'create-prd', name: 'Create PRD', tags: ['core'] },
    ]
    vi.mocked(runScript).mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify({ scenarios }),
      stderr: '',
      parsed: { scenarios },
    })
    const result = await discoverNode({ ...BASE_STATE, scenarioFilter: { tags: ['smoke'] } })
    expect(result.pendingScenarios).toHaveLength(1)
    expect(result.pendingScenarios![0].id).toBe('login-success')
  })

  it('id filter 生效', async () => {
    const scenarios = [
      { id: 'login-success', name: 'Login', tags: ['smoke'] },
      { id: 'create-prd', name: 'Create PRD', tags: ['core'] },
    ]
    vi.mocked(runScript).mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify({ scenarios }),
      stderr: '',
      parsed: { scenarios },
    })
    const result = await discoverNode({ ...BASE_STATE, scenarioFilter: { ids: ['create-prd'] } })
    expect(result.pendingScenarios).toHaveLength(1)
    expect(result.pendingScenarios![0].id).toBe('create-prd')
  })

  it('scenarios 非法形状 → throws unexpected scenarios shape', async () => {
    vi.mocked(runScript).mockResolvedValueOnce({
      exitCode: 0,
      stdout: '{"scenarios":[1,2,3]}',
      stderr: '',
      parsed: { scenarios: [1, 2, 3] },
    })
    await expect(discoverNode({ ...BASE_STATE })).rejects.toThrow(/unexpected scenarios shape/)
  })

  it('parsed null → returns empty pendingScenarios', async () => {
    vi.mocked(runScript).mockResolvedValueOnce({
      exitCode: 0,
      stdout: 'no json here',
      stderr: '',
      parsed: null,
    })
    const result = await discoverNode({ ...BASE_STATE })
    expect(result.pendingScenarios).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// pickNextScenarioNode
// ---------------------------------------------------------------------------

describe('pickNextScenarioNode', () => {
  it('空 pending → currentScenario null', async () => {
    const result = await pickNextScenarioNode({ ...BASE_STATE })
    expect(result.currentScenario).toBeNull()
  })

  it('有 pending → currentScenario 设为第一个', async () => {
    const scenarios = [
      { id: 'login', name: 'Login', tags: [] },
      { id: 'prd', name: 'PRD', tags: [] },
    ]
    const result = await pickNextScenarioNode({ ...BASE_STATE, pendingScenarios: scenarios })
    expect(result.currentScenario?.id).toBe('login')
  })
})

// ---------------------------------------------------------------------------
// runScenarioNode
// ---------------------------------------------------------------------------

describe('runScenarioNode', () => {
  const stateWithScenario = {
    ...BASE_STATE,
    sandboxHandle: SANDBOX_HANDLE,
    currentScenario: { id: 'login-success', name: 'Login', tags: ['smoke'] },
  }

  it('currentScenario null → throws', async () => {
    await expect(runScenarioNode({ ...BASE_STATE })).rejects.toThrow('currentScenario is null')
  })

  it('exit 0 → lastScenarioResult=pass + governor totalAttempts 自增', async () => {
    vi.mocked(runScript).mockResolvedValueOnce({
      exitCode: 0,
      stdout: '{"result":"pass","duration_ms":1234}',
      stderr: '',
      parsed: { result: 'pass', duration_ms: 1234 },
    })
    const result = await runScenarioNode(stateWithScenario)
    expect(result.lastScenarioResult).toBe('pass')
    expect(result.governorState?.totalAttempts).toBe(1)
    expect(finishScenarioRun).toHaveBeenCalledWith(100n, 'pass', expect.any(Object))
  })

  it('exit 1 → lastScenarioResult=fail', async () => {
    vi.mocked(runScript).mockResolvedValueOnce({
      exitCode: 1,
      stdout: '{"result":"fail"}',
      stderr: '',
      parsed: { result: 'fail' },
    })
    const result = await runScenarioNode(stateWithScenario)
    expect(result.lastScenarioResult).toBe('fail')
  })

  it('exit 1 + result=timeout → lastScenarioResult=timeout', async () => {
    vi.mocked(runScript).mockResolvedValueOnce({
      exitCode: 1,
      stdout: '{"result":"timeout"}',
      stderr: '',
      parsed: { result: 'timeout' },
    })
    const result = await runScenarioNode(stateWithScenario)
    expect(result.lastScenarioResult).toBe('timeout')
  })

  it('exit -1 (process timeout) → lastScenarioResult=timeout', async () => {
    vi.mocked(runScript).mockResolvedValueOnce({
      exitCode: -1,
      stdout: '',
      stderr: '[timeout]',
      parsed: null,
    })
    const result = await runScenarioNode(stateWithScenario)
    expect(result.lastScenarioResult).toBe('timeout')
  })

  it('perScenarioAttempts 正确累计', async () => {
    vi.mocked(runScript).mockResolvedValueOnce({
      exitCode: 0,
      stdout: '',
      stderr: '',
      parsed: null,
    })
    const result = await runScenarioNode(stateWithScenario)
    expect(result.governorState?.perScenarioAttempts['login-success']).toBe(1)
  })

  it('scenarioRunId 写入 state', async () => {
    vi.mocked(runScript).mockResolvedValueOnce({
      exitCode: 0,
      stdout: '',
      stderr: '',
      parsed: null,
    })
    const result = await runScenarioNode(stateWithScenario)
    expect(result.currentScenarioRunId).toBe(100n)
  })
})

// ---------------------------------------------------------------------------
// markGreenNode
// ---------------------------------------------------------------------------

describe('markGreenNode', () => {
  it('currentScenario null → returns {}', async () => {
    expect(await markGreenNode({ ...BASE_STATE })).toEqual({})
  })

  it('移除 currentScenario from pendingScenarios + 清空当前场景', async () => {
    const scenarios = [
      { id: 'login', name: 'L', tags: [] },
      { id: 'prd', name: 'P', tags: [] },
    ]
    const result = await markGreenNode({
      ...BASE_STATE,
      currentScenario: scenarios[0],
      pendingScenarios: scenarios,
    })
    expect(result.pendingScenarios).toHaveLength(1)
    expect(result.pendingScenarios![0].id).toBe('prd')
    expect(result.currentScenario).toBeNull()
  })

  it('清空 lastScenarioResult + evidenceDirTemp', async () => {
    const scenarios = [{ id: 'login', name: 'L', tags: [] }]
    const result = await markGreenNode({
      ...BASE_STATE,
      currentScenario: scenarios[0],
      pendingScenarios: scenarios,
      lastScenarioResult: 'pass',
      evidenceDirTemp: '/tmp/evidence',
    })
    expect(result.lastScenarioResult).toBeNull()
    expect(result.evidenceDirTemp).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// markUnfixableNode
// ---------------------------------------------------------------------------

describe('markUnfixableNode', () => {
  it('currentScenario null → returns {}', async () => {
    expect(await markUnfixableNode({ ...BASE_STATE })).toEqual({})
  })

  it('移除 currentScenario + finishScenarioRun 调用', async () => {
    const scenarios = [
      { id: 'login', name: 'L', tags: [] },
      { id: 'prd', name: 'P', tags: [] },
    ]
    const result = await markUnfixableNode({
      ...BASE_STATE,
      currentScenario: scenarios[0],
      currentScenarioRunId: 100n,
      pendingScenarios: scenarios,
    })
    expect(result.pendingScenarios).toHaveLength(1)
    expect(result.currentScenario).toBeNull()
    expect(finishScenarioRun).toHaveBeenCalledWith(100n, 'unfixable', expect.any(Object))
  })

  it('currentScenarioRunId null → finishScenarioRun 不调用', async () => {
    const scenarios = [{ id: 'login', name: 'L', tags: [] }]
    await markUnfixableNode({
      ...BASE_STATE,
      currentScenario: scenarios[0],
      currentScenarioRunId: null,
      pendingScenarios: scenarios,
    })
    expect(finishScenarioRun).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// resetIterationBranchNode
// ---------------------------------------------------------------------------

describe('resetIterationBranchNode', () => {
  it('fetch + reset 成功 → returns {}', async () => {
    vi.mocked(runScript)
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '', parsed: null }) // fetch
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '', parsed: null }) // reset
    const result = await resetIterationBranchNode({ ...BASE_STATE })
    expect(result).toEqual({})
  })

  it('fetch 失败 → throws git fetch failed', async () => {
    vi.mocked(runScript).mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'network error',
      parsed: null,
    })
    await expect(resetIterationBranchNode({ ...BASE_STATE })).rejects.toThrow('git fetch failed')
  })

  it('reset 失败 → throws git reset failed', async () => {
    vi.mocked(runScript)
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '', parsed: null }) // fetch ok
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'conflict', parsed: null }) // reset fail
    await expect(resetIterationBranchNode({ ...BASE_STATE })).rejects.toThrow('git reset failed')
  })

  it('无 gitlab token → fetch 不包含 PRIVATE-TOKEN header env', async () => {
    vi.mocked(resolveGitlabConfig).mockResolvedValue({ url: '', token: '', skipTlsVerify: false })
    vi.mocked(runScript)
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '', parsed: null })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '', parsed: null })
    await resetIterationBranchNode({ ...BASE_STATE })
    const fetchCall = vi.mocked(runScript).mock.calls[0]
    // env 不含 GIT_CONFIG_KEY_0
    const opts = fetchCall[2] as any
    expect(opts?.env?.GIT_CONFIG_KEY_0).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// createSummaryMrNode
// ---------------------------------------------------------------------------

describe('createSummaryMrNode', () => {
  it('GitLab config 无 token → 跳过 MR 创建 + run=passed', async () => {
    vi.mocked(resolveGitlabConfig).mockResolvedValue({ url: '', token: '', skipTlsVerify: false })
    const result = await createSummaryMrNode({ ...BASE_STATE })
    expect(result).toEqual({})
    expect(updateE2eRunStatus).toHaveBeenCalledWith(42n, 'passed', expect.any(Object))
  })

  it('GitLab API 成功 → summaryMrUrl 写入 + run=passed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ web_url: 'https://gitlab.example.com/-/merge_requests/99' }),
      }),
    )
    const result = await createSummaryMrNode({ ...BASE_STATE })
    expect(result.summaryMrUrl).toContain('merge_requests')
    expect(updateE2eRunStatus).toHaveBeenCalledWith(42n, 'passed', expect.any(Object))
    vi.unstubAllGlobals()
  })

  it('GitLab API 返回非 ok → summaryMrUrl=null + run 仍 passed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        text: () => Promise.resolve('branch already has MR'),
      }),
    )
    const result = await createSummaryMrNode({ ...BASE_STATE })
    expect(result.summaryMrUrl).toBeNull()
    expect(updateE2eRunStatus).toHaveBeenCalledWith(42n, 'passed', expect.any(Object))
    vi.unstubAllGlobals()
  })

  it('fetch 抛出异常 → summaryMrUrl=null + run 仍 passed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    const result = await createSummaryMrNode({ ...BASE_STATE })
    expect(result.summaryMrUrl).toBeNull()
    expect(updateE2eRunStatus).toHaveBeenCalledWith(42n, 'passed', expect.any(Object))
    vi.unstubAllGlobals()
  })
})

// ---------------------------------------------------------------------------
// finalizeFailedNode
// ---------------------------------------------------------------------------

describe('finalizeFailedNode', () => {
  it('更新 run status=failed + 写入 errorMessage', async () => {
    const result = await finalizeFailedNode({ ...BASE_STATE })
    expect(updateE2eRunStatus).toHaveBeenCalledWith(42n, 'failed', expect.any(Object))
    expect(result.errorMessage).toBeTruthy()
  })

  it('超时情况 → errorMessage 包含 over_time_limit', async () => {
    const state = {
      ...BASE_STATE,
      governorState: {
        ...DEFAULT_GOVERNOR,
        runStartedAt: Date.now() - 5 * 3600 * 1000, // 5 hours ago
      },
    }
    const result = await finalizeFailedNode(state)
    expect(result.errorMessage).toMatch(/over_time_limit/)
  })

  it('超 totalAttempts → errorMessage 包含 over_total_attempts', async () => {
    const state = {
      ...BASE_STATE,
      governorState: {
        ...DEFAULT_GOVERNOR,
        totalAttempts: 30,
      },
    }
    const result = await finalizeFailedNode(state)
    expect(result.errorMessage).toMatch(/over_total_attempts/)
  })
})

// ---------------------------------------------------------------------------
// governorCheck
// ---------------------------------------------------------------------------

describe('governorCheck', () => {
  it('未超限 → continue', () => {
    expect(governorCheck({ ...BASE_STATE })).toBe('continue')
  })

  it('totalAttempts >= maxTotalAttempts → over_budget', () => {
    const state = {
      ...BASE_STATE,
      governorState: { ...DEFAULT_GOVERNOR, totalAttempts: 30 },
    }
    expect(governorCheck(state)).toBe('over_budget')
  })

  it('run 时间超限 → over_budget', () => {
    const state = {
      ...BASE_STATE,
      governorState: {
        ...DEFAULT_GOVERNOR,
        runStartedAt: Date.now() - 5 * 3600 * 1000,
      },
    }
    expect(governorCheck(state)).toBe('over_budget')
  })

  it('totalAttempts < maxTotalAttempts + 未超时 → continue', () => {
    const state = {
      ...BASE_STATE,
      governorState: { ...DEFAULT_GOVERNOR, totalAttempts: 29 },
    }
    expect(governorCheck(state)).toBe('continue')
  })
})
