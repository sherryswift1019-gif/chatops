import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const TEST_BASE = mkdtempSync(join(tmpdir(), 'qi-e2e-runner-test-'))

// Mock 所有 IO 依赖：bare push / sandbox / scenario runner / db repos
vi.mock('../../quick-impl/qi-bare-repo.js', () => ({
  pushToBare: vi.fn(async () => {}),
}))

vi.mock('../../quick-impl/qi-sandbox.js', async () => {
  const actual = await vi.importActual<typeof import('../../quick-impl/qi-sandbox.js')>(
    '../../quick-impl/qi-sandbox.js',
  )
  return {
    ...actual,
    provisionQiSandbox: vi.fn(),
    teardownQiSandbox: vi.fn(async () => {}),
  }
})

vi.mock('../../agent/e2e-scenario/runner.js', () => ({
  runE2eScenario: vi.fn(),
}))

vi.mock('../../db/repositories/requirements.js', () => ({
  getRequirementById: vi.fn(),
}))

vi.mock('../../db/repositories/e2e-target-projects.js', () => ({
  listE2eTargetProjects: vi.fn(),
  getE2eTargetProject: vi.fn(),
}))

// Dynamic imports 后的引用
import { provisionQiSandbox, teardownQiSandbox, SandboxProvisionError } from '../../quick-impl/qi-sandbox.js'
import { pushToBare } from '../../quick-impl/qi-bare-repo.js'
import { runE2eScenario } from '../../agent/e2e-scenario/runner.js'
import { getRequirementById } from '../../db/repositories/requirements.js'
import { listE2eTargetProjects } from '../../db/repositories/e2e-target-projects.js'

// 触发 qi_e2e_runner 节点注册
import '../../pipeline/node-types/qi-e2e-runner.js'
import { getExecutor } from '../../pipeline/node-types/registry.js'

const VALID_PLAYBOOK_YAML = `
specPath: docs/specs/qi-1.md
specTitle: 测试需求
scenarios:
  - id: login-happy
    name: 正常登录
    tags: []
    steps:
      - "POST /api/login body {username:'admin',password:'x'}"
    acceptance:
      - kind: url_match
        value: /dashboard
  - id: login-bad
    name: 密码错
    tags: []
    steps:
      - "POST /api/login bad pwd"
    acceptance:
      - kind: url_match
        value: /login
`

function makeWorktreeWithPlaybook(opts: { requirementId: number; playbookYaml?: string }) {
  const wt = mkdtempSync(join(TEST_BASE, 'wt-'))
  if (opts.playbookYaml !== undefined) {
    mkdirSync(join(wt, 'docs/test-playbooks'), { recursive: true })
    writeFileSync(join(wt, 'docs/test-playbooks', `qi-${opts.requirementId}.yaml`), opts.playbookYaml)
  }
  return wt
}

function execCtx(overrides: Record<string, unknown> = {}) {
  return {
    runId: 1,
    pipelineId: 1,
    nodeId: 'qi_e2e_runner',
    triggerParams: {},
    vars: {},
    steps: {} as Record<string, { status: 'success'; output: Record<string, unknown> }>,
    ...overrides,
  } as unknown as import('../../pipeline/node-types/types.js').ExecutionContext
}

const SANDBOX_HANDLE = {
  sandboxDir: '/tmp/sandbox-x',
  envId: 'env-x',
  kind: 'docker-compose-local',
  endpoints: { web: 'http://localhost:8080' },
  internalRefs: {},
  requirementId: 1,
  attempt: 1,
  deployScript: '/tmp/sandbox-x/deploy.sh',
  targetProjectId: 'p1',
}

describe('qi_e2e_runner node', () => {
  beforeEach(() => {
    vi.mocked(pushToBare).mockReset()
    vi.mocked(provisionQiSandbox).mockReset()
    vi.mocked(teardownQiSandbox).mockReset()
    vi.mocked(runE2eScenario).mockReset()
    vi.mocked(getRequirementById).mockReset()
    vi.mocked(listE2eTargetProjects).mockReset()

    vi.mocked(pushToBare).mockResolvedValue(undefined)
    vi.mocked(teardownQiSandbox).mockResolvedValue(undefined)
    vi.mocked(getRequirementById).mockResolvedValue({
      id: 1,
      title: 't',
      rawInput: 'r',
      status: 'in_progress',
      branch: 'feat/qi-1',
      baseBranch: 'main',
      gitlabProject: 'group/p1',
      worktreePath: null,
      pipelineRunId: null,
      currentStage: null,
      retryCounters: {},
      specSources: [],
      planSources: [],
      reviewerNotes: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as Awaited<ReturnType<typeof getRequirementById>>)
    vi.mocked(listE2eTargetProjects).mockResolvedValue([
      {
        id: 'p1',
        name: 'P1',
        gitlabRepo: 'group/p1',
        defaultBranch: 'main',
        scripts: { build: 'build.sh', deploy: 'deploy.sh', test: 'test.sh' },
        metadata: {},
      } as unknown as Awaited<ReturnType<typeof listE2eTargetProjects>>[number],
    ])
    vi.mocked(provisionQiSandbox).mockResolvedValue({ ...SANDBOX_HANDLE })

    // 默认所有 scenario pass
    vi.mocked(runE2eScenario).mockImplementation(async (input) => ({
      manifest: {
        scenarioId: input.scenarioId,
        attemptNumber: input.attemptNumber,
        result: 'pass',
        startedAt: '2026-05-09T10:00:00.000Z',
        finishedAt: '2026-05-09T10:00:30.000Z',
        durationMs: 30000,
        claudeTrace: [],
        acceptanceResults: [],
        artifacts: [],
        errorMessage: null,
        meta: null,
      },
      rawOutput: '',
      errorMessage: null,
    }))
  })

  it('全部 scenario pass → result=pass, attempt=1', async () => {
    const wt = makeWorktreeWithPlaybook({ requirementId: 1, playbookYaml: VALID_PLAYBOOK_YAML })
    const exec = getExecutor('qi_e2e_runner')!
    const result = await exec.execute(
      { requirementId: 1, worktreePath: wt, branch: 'feat/qi-1', bareRepoPath: '/tmp/bare' },
      execCtx(),
    )
    expect(result.status).toBe('success')
    expect(result.output.result).toBe('pass')
    expect(result.output.attempt).toBe(1)
    expect(result.output.scenariosRun).toBe(2)
    expect(result.output.passed).toBe(2)
    expect(result.output.failed).toBe(0)
    expect(result.output.failureReport).toBeNull()
    expect(vi.mocked(pushToBare)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(teardownQiSandbox)).toHaveBeenCalledTimes(1)
  })

  it('runId 用 -BigInt(requirementId) 防止撞 e2e_runs.id', async () => {
    const wt = makeWorktreeWithPlaybook({ requirementId: 42, playbookYaml: VALID_PLAYBOOK_YAML })
    const exec = getExecutor('qi_e2e_runner')!
    await exec.execute(
      { requirementId: 42, worktreePath: wt, branch: 'feat/qi-42', bareRepoPath: '/tmp/bare' },
      execCtx(),
    )
    const calls = vi.mocked(runE2eScenario).mock.calls
    expect(calls[0][0].runId).toBe(-42n)
  })

  it('任一 scenario fail → result=fail + failureReport', async () => {
    const wt = makeWorktreeWithPlaybook({ requirementId: 2, playbookYaml: VALID_PLAYBOOK_YAML })
    vi.mocked(runE2eScenario).mockImplementationOnce(async (input) => ({
      manifest: {
        scenarioId: input.scenarioId,
        attemptNumber: input.attemptNumber,
        result: 'fail',
        startedAt: '2026-05-09T10:00:00.000Z',
        finishedAt: '2026-05-09T10:00:30.000Z',
        durationMs: 30000,
        claudeTrace: [],
        acceptanceResults: [
          { kind: 'url_match', index: 0, result: 'fail', expected: '/dashboard', actual: '/login', reason: 'no redirect' },
        ],
        artifacts: [],
        errorMessage: null,
        meta: null,
      },
      rawOutput: '',
      errorMessage: null,
    }))
    const exec = getExecutor('qi_e2e_runner')!
    const result = await exec.execute(
      { requirementId: 2, worktreePath: wt, branch: 'feat/qi-2', bareRepoPath: '/tmp/bare' },
      execCtx(),
    )
    expect(result.output.result).toBe('fail')
    expect(result.output.failed).toBe(1)
    expect(result.output.passed).toBe(1)
    const fr = result.output.failureReport as { scenarios: Array<{ id: string; failureReason: string }> }
    expect(fr.scenarios.length).toBe(1)
    expect(fr.scenarios[0].failureReason).toContain('url_match')
  })

  it('teardown 在 try-finally 里：scenario 抛错也清理', async () => {
    const wt = makeWorktreeWithPlaybook({ requirementId: 3, playbookYaml: VALID_PLAYBOOK_YAML })
    vi.mocked(runE2eScenario).mockRejectedValueOnce(new Error('claude crashed'))
    const exec = getExecutor('qi_e2e_runner')!
    const result = await exec.execute(
      { requirementId: 3, worktreePath: wt, branch: 'feat/qi-3', bareRepoPath: '/tmp/bare' },
      execCtx(),
    )
    expect(vi.mocked(teardownQiSandbox)).toHaveBeenCalledTimes(1)
    // 第一个 scenario 抛错应被捕成 errorMessage，第二个继续跑（默认 pass）
    expect(result.output.result).toBe('fail')
    expect(result.output.failed).toBe(1)
  })

  it('SandboxProvisionError → result=sandbox_failed, 不调 teardown', async () => {
    const wt = makeWorktreeWithPlaybook({ requirementId: 4, playbookYaml: VALID_PLAYBOOK_YAML })
    vi.mocked(provisionQiSandbox).mockRejectedValueOnce(
      new SandboxProvisionError('git-clone', 'remote repo not found'),
    )
    const exec = getExecutor('qi_e2e_runner')!
    const result = await exec.execute(
      { requirementId: 4, worktreePath: wt, branch: 'feat/qi-4', bareRepoPath: '/tmp/bare' },
      execCtx(),
    )
    expect(result.status).toBe('failed')
    expect(result.output.result).toBe('sandbox_failed')
    expect(result.output.sandboxError).toContain('git-clone')
    expect(vi.mocked(teardownQiSandbox)).not.toHaveBeenCalled()
  })

  it('playbook YAML 缺失 → result=skipped + skipped=true（视为无需 E2E 的纯配置改动；UI 能区分 pass/skipped）', async () => {
    const wt = makeWorktreeWithPlaybook({ requirementId: 5 }) // no playbook file
    const exec = getExecutor('qi_e2e_runner')!
    const result = await exec.execute(
      { requirementId: 5, worktreePath: wt, branch: 'feat/qi-5', bareRepoPath: '/tmp/bare' },
      execCtx(),
    )
    expect(result.status).toBe('success')
    expect(result.output.result).toBe('skipped')
    expect(result.output.skipped).toBe(true)
    expect(result.output.scenariosRun).toBe(0)
    expect(vi.mocked(provisionQiSandbox)).not.toHaveBeenCalled()
  })

  it('playbook scenarios > 5 → 合规校验拒，进 fail 路径', async () => {
    const yamlMany = `
specPath: docs/specs/qi-1.md
scenarios:
${Array.from({ length: 6 }, (_, i) => `  - id: s${i}
    name: scenario ${i}
    tags: []
    steps: ["POST /x"]
    acceptance: [{ kind: url_match, value: /a }]
`).join('')}
`
    const wt = makeWorktreeWithPlaybook({ requirementId: 6, playbookYaml: yamlMany })
    const exec = getExecutor('qi_e2e_runner')!
    const result = await exec.execute(
      { requirementId: 6, worktreePath: wt, branch: 'feat/qi-6', bareRepoPath: '/tmp/bare' },
      execCtx(),
    )
    expect(result.output.result).toBe('fail')
    const fr = result.output.failureReport as { scenarios: Array<{ failureReason: string }> }
    expect(fr.scenarios[0].failureReason).toContain('max 5')
  })

  it('attempt 自增：ctx.steps 含上次 attempt=1 → 本次 attempt=2', async () => {
    const wt = makeWorktreeWithPlaybook({ requirementId: 7, playbookYaml: VALID_PLAYBOOK_YAML })
    const exec = getExecutor('qi_e2e_runner')!
    const result = await exec.execute(
      { requirementId: 7, worktreePath: wt, branch: 'feat/qi-7', bareRepoPath: '/tmp/bare' },
      execCtx({
        steps: {
          qi_e2e_runner: { status: 'success', output: { attempt: 1, result: 'fail' } },
        },
      }),
    )
    expect(result.output.attempt).toBe(2)
  })

  it('push to bare 失败 → result=sandbox_failed', async () => {
    const wt = makeWorktreeWithPlaybook({ requirementId: 8, playbookYaml: VALID_PLAYBOOK_YAML })
    vi.mocked(pushToBare).mockRejectedValueOnce(new Error('bare repo not init'))
    const exec = getExecutor('qi_e2e_runner')!
    const result = await exec.execute(
      { requirementId: 8, worktreePath: wt, branch: 'feat/qi-8', bareRepoPath: '/tmp/bare-x' },
      execCtx(),
    )
    expect(result.status).toBe('failed')
    expect(result.output.result).toBe('sandbox_failed')
    expect(result.output.sandboxError).toContain('push to bare failed')
    expect(vi.mocked(provisionQiSandbox)).not.toHaveBeenCalled()
  })

  it('反查 e2e_target_projects 找不到匹配 → result=sandbox_failed', async () => {
    const wt = makeWorktreeWithPlaybook({ requirementId: 9, playbookYaml: VALID_PLAYBOOK_YAML })
    vi.mocked(listE2eTargetProjects).mockResolvedValueOnce([])
    const exec = getExecutor('qi_e2e_runner')!
    const result = await exec.execute(
      { requirementId: 9, worktreePath: wt, branch: 'feat/qi-9', bareRepoPath: '/tmp/bare' },
      execCtx(),
    )
    expect(result.status).toBe('failed')
    expect(result.output.result).toBe('sandbox_failed')
    expect(result.output.sandboxError).toContain('no e2e_target_projects matches')
  })

  it('参数校验：缺 requirementId/worktreePath/branch/bareRepoPath 直接 fail', async () => {
    const exec = getExecutor('qi_e2e_runner')!
    expect((await exec.execute({}, execCtx())).status).toBe('failed')
    expect((await exec.execute({ requirementId: 1 }, execCtx())).status).toBe('failed')
    expect((await exec.execute({ requirementId: 1, worktreePath: '/x' }, execCtx())).status).toBe('failed')
    expect((await exec.execute({ requirementId: 1, worktreePath: '/x', branch: 'b' }, execCtx())).status).toBe('failed')
  })
})
