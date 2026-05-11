/**
 * QI E2E Test 节点 — Mock 需求场景测试
 *
 * 覆盖 e2e_router 的全部 4 条出边：
 *   A. 全 pass   → final_approval
 *   B. fail(1st) → dev_fix_author（尝试修复后重试）
 *   C. fail(2nd) → e2e_im_intervention（超预算，升级人工）
 *   D. sandbox_failed → e2e_sandbox_intervention
 *   E. no-playbook → pass/skip（无需 E2E 的纯配置改动）
 *
 * 所有外部 IO（bare push / sandbox / Claude runner / DB）全部 mock；
 * 测试聚焦节点的状态机逻辑和 failureReport 组装。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const TEST_BASE = mkdtempSync(join(tmpdir(), 'qi-e2e-scenarios-'))

// ─── Mock IO 依赖 ──────────────────────────────────────────────────────────
vi.mock('../../quick-impl/qi-bare-repo.js', () => ({ pushToBare: vi.fn(async () => {}) }))

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

vi.mock('../../agent/e2e-scenario/runner.js', () => ({ runE2eScenario: vi.fn() }))

vi.mock('../../db/repositories/requirements.js', () => ({ getRequirementById: vi.fn() }))

vi.mock('../../db/repositories/e2e-target-projects.js', () => ({
  listE2eTargetProjects: vi.fn(),
  getE2eTargetProject: vi.fn(),
}))

import { provisionQiSandbox, teardownQiSandbox, SandboxProvisionError } from '../../quick-impl/qi-sandbox.js'
import { pushToBare } from '../../quick-impl/qi-bare-repo.js'
import { runE2eScenario } from '../../agent/e2e-scenario/runner.js'
import { getRequirementById } from '../../db/repositories/requirements.js'
import { listE2eTargetProjects } from '../../db/repositories/e2e-target-projects.js'

import '../../pipeline/node-types/qi-e2e-runner.js'
import { getExecutor } from '../../pipeline/node-types/registry.js'
import type { ExecutionContext } from '../../pipeline/node-types/types.js'

// ─── 固定测试数据 ───────────────────────────────────────────────────────────

/** 模拟需求：一个登录功能改动 */
const MOCK_REQUIREMENT_ID = 101

/**
 * 真实风格的 playbook YAML（3 个 scenario，覆盖 happy/negative/边界）
 * 对应 docs/test-playbooks/qi-101.yaml
 * acceptance kind 只用 schema 合法值：url_match / dom_visible / dom_text_contains / api_response
 */
const REALISTIC_PLAYBOOK_YAML = `
specPath: docs/specs/qi-101.md
specTitle: 登录功能：记住我 + 密码错误提示

scenarios:
  - id: login-remember-me
    name: 记住我 — 勾选后 token 7 天有效
    tags:
      - happy
      - auth
    steps:
      - "访问 /login，勾选「记住我」，填 admin/Pass2026 点登录"
      - "验证跳转到 /dashboard"
      - "查 DB：session token expiry ≥ 7 天"
    acceptance:
      - kind: url_match
        value: /dashboard
      - kind: api_response
        request: GET /api/session/info
        expect_status: 200
        expect_body_contains: '"remember":true'

  - id: login-wrong-password
    name: 密码错误 — 显示「密码错误」提示且不跳转
    tags:
      - negative
      - auth
    steps:
      - "访问 /login，填 admin/WrongPass，点登录"
      - "验证页面留在 /login"
      - "验证出现「密码错误」DOM 文字"
    acceptance:
      - kind: url_match
        value: /login
      - kind: dom_text_contains
        selector: ".error-message"
        value: "密码错误"

  - id: login-session-expire
    name: Session 过期 — 访问受保护页自动重定向 /login
    tags:
      - edge
      - auth
    steps:
      - "模拟 session 过期（删 cookie）"
      - "直接访问 /dashboard"
      - "验证跳转到 /login"
    acceptance:
      - kind: url_match
        value: /login
`

const SANDBOX_HANDLE = {
  sandboxDir: '/tmp/qi-sandbox-101',
  envId: 'env-qi-101-attempt-1',
  kind: 'docker-compose-local',
  endpoints: { web: 'http://localhost:18080' },
  containerId: 'chatops-sandbox-101',
  workdir: '/app',
  internalRefs: {},
  requirementId: MOCK_REQUIREMENT_ID,
  attempt: 1,
  deployScript: '/tmp/qi-sandbox-101/deploy.sh',
  targetProjectId: 'target-chatops-login',
}

const MOCK_REQUIREMENT = {
  id: MOCK_REQUIREMENT_ID,
  title: '登录功能：记住我 + 密码错误提示',
  rawInput: '用户希望增加「记住我」选项，token 7 天有效；密码错误应有明确提示',
  status: 'testing' as const,
  branch: `feat/qi-${MOCK_REQUIREMENT_ID}`,
  baseBranch: 'main',
  gitlabProject: 'PAM/devops/chatops',
  worktreePath: null,
  pipelineRunId: null,
  currentStage: null,
  retryCounters: {},
  specSources: [],
  planSources: [],
  reviewerNotes: [],
  createdAt: new Date(),
  updatedAt: new Date(),
}

const MOCK_E2E_TARGETS = [
  {
    id: 'target-chatops-login',
    name: 'ChatOps Login Service',
    gitlabRepo: 'PAM/devops/chatops',
    defaultBranch: 'main',
    scripts: { build: 'build.sh', deploy: 'deploy.sh', test: 'test.sh' },
    metadata: {},
  },
]

// ─── 辅助函数 ──────────────────────────────────────────────────────────────

function makeWorktree(opts: { playbookYaml?: string } = {}) {
  const wt = mkdtempSync(join(TEST_BASE, 'wt-'))
  if (opts.playbookYaml !== undefined) {
    mkdirSync(join(wt, 'docs/test-playbooks'), { recursive: true })
    writeFileSync(
      join(wt, 'docs/test-playbooks', `qi-${MOCK_REQUIREMENT_ID}.yaml`),
      opts.playbookYaml,
    )
  }
  return wt
}

function makeCtx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    runId: 9001,
    pipelineId: 1,
    nodeId: 'qi_e2e_runner',
    triggerParams: { requirementId: MOCK_REQUIREMENT_ID },
    vars: {},
    steps: {},
    ...overrides,
  } as unknown as ExecutionContext
}

/** 生成单个 scenario 的 pass manifest */
function passManifest(scenarioId: string, attempt = 1) {
  return {
    manifest: {
      scenarioId,
      attemptNumber: attempt,
      result: 'pass' as const,
      startedAt: '2026-05-09T10:00:00.000Z',
      finishedAt: '2026-05-09T10:00:45.000Z',
      durationMs: 45000,
      claudeTrace: [
        { step: 1, intent: '访问 /login', tool: 'browser_navigate', verdict: 'ok' as const, note: null },
        { step: 2, intent: '填表单并提交', tool: 'browser_click', verdict: 'ok' as const, note: null },
        { step: 3, intent: '验证 URL', tool: 'browser_evaluate', verdict: 'ok' as const, note: null },
      ],
      acceptanceResults: [
        { kind: 'url_match', index: 0, result: 'pass' as const, expected: '/dashboard', actual: '/dashboard', reason: null },
      ],
      artifacts: [],
      errorMessage: null,
      meta: null,
    },
    rawOutput: '[claude trace output]',
    errorMessage: null,
  }
}

/** 生成单个 scenario 的 fail manifest */
function failManifest(scenarioId: string, attempt = 1, failReason = 'URL 不匹配') {
  return {
    manifest: {
      scenarioId,
      attemptNumber: attempt,
      result: 'fail' as const,
      startedAt: '2026-05-09T10:00:00.000Z',
      finishedAt: '2026-05-09T10:01:00.000Z',
      durationMs: 60000,
      claudeTrace: [
        { step: 1, intent: '访问 /login', tool: 'browser_navigate', verdict: 'ok' as const, note: null },
        { step: 2, intent: '填表单并提交', tool: 'browser_click', verdict: 'ok' as const, note: null },
        { step: 3, intent: '验证跳转失败', tool: 'browser_evaluate', verdict: 'error' as const, note: failReason },
      ],
      acceptanceResults: [
        {
          kind: 'url_match',
          index: 0,
          result: 'fail' as const,
          expected: '/dashboard',
          actual: '/login',
          reason: failReason,
        },
      ],
      artifacts: [],
      errorMessage: null,
      meta: null,
    },
    rawOutput: '[claude trace output with failure details]',
    errorMessage: null,
  }
}

// ─── 测试套件 ──────────────────────────────────────────────────────────────

describe('QI E2E Test 节点 — Mock 需求场景测试（需求 #101: 登录功能）', () => {
  beforeEach(() => {
    vi.mocked(pushToBare).mockReset().mockResolvedValue(undefined)
    vi.mocked(provisionQiSandbox).mockReset().mockResolvedValue({ ...SANDBOX_HANDLE })
    vi.mocked(teardownQiSandbox).mockReset().mockResolvedValue(undefined)
    vi.mocked(runE2eScenario).mockReset()
    vi.mocked(getRequirementById).mockReset().mockResolvedValue(MOCK_REQUIREMENT as never)
    vi.mocked(listE2eTargetProjects).mockReset().mockResolvedValue(MOCK_E2E_TARGETS as never)
  })

  // ─── 场景 A: 全部通过 → 进 final_approval ─────────────────────────────
  describe('场景 A: 3 个 scenario 全部 pass', () => {
    it('节点返回 result=pass, attempt=1, 所有计数正确', async () => {
      const wt = makeWorktree({ playbookYaml: REALISTIC_PLAYBOOK_YAML })
      vi.mocked(runE2eScenario)
        .mockResolvedValueOnce(passManifest('login-remember-me'))
        .mockResolvedValueOnce(passManifest('login-wrong-password'))
        .mockResolvedValueOnce(passManifest('login-session-expire'))

      const exec = getExecutor('qi_e2e_runner')!
      const result = await exec.execute(
        {
          requirementId: MOCK_REQUIREMENT_ID,
          worktreePath: wt,
          branch: `feat/qi-${MOCK_REQUIREMENT_ID}`,
          bareRepoPath: '/tmp/bare-qi-101',
        },
        makeCtx(),
      )

      // 节点本身执行成功
      expect(result.status).toBe('success')
      // e2e_router 读这个字段决定下游
      expect(result.output.result).toBe('pass')
      expect(result.output.attempt).toBe(1)
      expect(result.output.scenariosRun).toBe(3)
      expect(result.output.passed).toBe(3)
      expect(result.output.failed).toBe(0)
      expect(result.output.failureReport).toBeNull()
      expect(result.output.skipped).toBeUndefined()
    })

    it('每个 scenario 都被串行调用，runId 为 -BigInt(requirementId)', async () => {
      const wt = makeWorktree({ playbookYaml: REALISTIC_PLAYBOOK_YAML })
      vi.mocked(runE2eScenario)
        .mockResolvedValueOnce(passManifest('login-remember-me'))
        .mockResolvedValueOnce(passManifest('login-wrong-password'))
        .mockResolvedValueOnce(passManifest('login-session-expire'))

      const exec = getExecutor('qi_e2e_runner')!
      await exec.execute(
        {
          requirementId: MOCK_REQUIREMENT_ID,
          worktreePath: wt,
          branch: `feat/qi-${MOCK_REQUIREMENT_ID}`,
          bareRepoPath: '/tmp/bare-qi-101',
        },
        makeCtx(),
      )

      const calls = vi.mocked(runE2eScenario).mock.calls
      expect(calls).toHaveLength(3)
      // runId 防撞库：用 -BigInt(requirementId)
      expect(calls[0][0].runId).toBe(-BigInt(MOCK_REQUIREMENT_ID))
      // scenario 按 playbook 顺序串行
      expect(calls[0][0].scenarioId).toBe('login-remember-me')
      expect(calls[1][0].scenarioId).toBe('login-wrong-password')
      expect(calls[2][0].scenarioId).toBe('login-session-expire')
    })

    it('sandbox 在 finally 里 teardown，哪怕 scenario 全部 pass 也执行', async () => {
      const wt = makeWorktree({ playbookYaml: REALISTIC_PLAYBOOK_YAML })
      vi.mocked(runE2eScenario)
        .mockResolvedValue(passManifest('login-remember-me'))

      const exec = getExecutor('qi_e2e_runner')!
      await exec.execute(
        {
          requirementId: MOCK_REQUIREMENT_ID,
          worktreePath: wt,
          branch: `feat/qi-${MOCK_REQUIREMENT_ID}`,
          bareRepoPath: '/tmp/bare-qi-101',
        },
        makeCtx(),
      )

      expect(vi.mocked(teardownQiSandbox)).toHaveBeenCalledOnce()
      expect(vi.mocked(teardownQiSandbox)).toHaveBeenCalledWith(
        expect.objectContaining({ envId: SANDBOX_HANDLE.envId }),
      )
    })

    it('evidence dir 在 sandbox 之外（teardown 不会误删）', async () => {
      const wt = makeWorktree({ playbookYaml: REALISTIC_PLAYBOOK_YAML })
      vi.mocked(runE2eScenario)
        .mockResolvedValue(passManifest('login-remember-me'))

      const exec = getExecutor('qi_e2e_runner')!
      await exec.execute(
        {
          requirementId: MOCK_REQUIREMENT_ID,
          worktreePath: wt,
          branch: `feat/qi-${MOCK_REQUIREMENT_ID}`,
          bareRepoPath: '/tmp/bare-qi-101',
        },
        makeCtx(),
      )

      const calls = vi.mocked(runE2eScenario).mock.calls
      expect(calls.length).toBeGreaterThan(0)
      for (const [{ evidenceDir }] of calls) {
        // 必须在 qi-evidence 命名空间下，包含 reqId/attempt/scenarioId
        expect(evidenceDir).toMatch(/qi-evidence/)
        expect(evidenceDir).toContain(`qi-${MOCK_REQUIREMENT_ID}`)
        expect(evidenceDir).toContain('attempt-1')
        // 关键不变量：evidenceDir 不在 sandboxDir 里，否则 teardown rmSync 会带走它
        expect(evidenceDir.startsWith(SANDBOX_HANDLE.sandboxDir)).toBe(false)
      }
    })
  })

  // ─── 场景 B: 首次失败 → dev_fix_author ──────────────────────────
  describe('场景 B: 第 1 次 attempt — 1 个 scenario fail → 进 fix-loop', () => {
    it('返回 result=fail + failureReport，attempt=1，e2e_router 会路由到 fix-loop', async () => {
      const wt = makeWorktree({ playbookYaml: REALISTIC_PLAYBOOK_YAML })
      vi.mocked(runE2eScenario)
        .mockResolvedValueOnce(passManifest('login-remember-me'))
        .mockResolvedValueOnce(
          failManifest('login-wrong-password', 1, '页面未显示「密码错误」提示，实际出现「系统错误」'),
        )
        .mockResolvedValueOnce(passManifest('login-session-expire'))

      const exec = getExecutor('qi_e2e_runner')!
      const result = await exec.execute(
        {
          requirementId: MOCK_REQUIREMENT_ID,
          worktreePath: wt,
          branch: `feat/qi-${MOCK_REQUIREMENT_ID}`,
          bareRepoPath: '/tmp/bare-qi-101',
        },
        makeCtx(),
      )

      expect(result.status).toBe('success') // 节点本身不算失败
      expect(result.output.result).toBe('fail')
      expect(result.output.attempt).toBe(1) // 首次，e2e_router 会走 fix-loop
      expect(result.output.scenariosRun).toBe(3)
      expect(result.output.passed).toBe(2)
      expect(result.output.failed).toBe(1)

      // failureReport 是 dev-loop 的输入，检查关键字段
      const fr = result.output.failureReport as {
        total: number
        passed: number
        failed: number
        scenarios: Array<{
          id: string
          name: string
          result: string
          failureReason: string
          failedAcceptances: Array<{ kind: string; result: string }>
        }>
      }
      expect(fr.total).toBe(3)
      expect(fr.passed).toBe(2)
      expect(fr.failed).toBe(1)
      expect(fr.scenarios).toHaveLength(1)
      expect(fr.scenarios[0].id).toBe('login-wrong-password')
      expect(fr.scenarios[0].name).toBe('密码错误 — 显示「密码错误」提示且不跳转')
      expect(fr.scenarios[0].result).toBe('fail')
      expect(fr.scenarios[0].failureReason).toContain('密码错误')
      expect(fr.scenarios[0].failedAcceptances[0].kind).toBe('url_match')
    })

    it('单个 scenario 被 Claude 崩掉（抛异常）→ 兜底为 fail，其他 scenario 继续', async () => {
      const wt = makeWorktree({ playbookYaml: REALISTIC_PLAYBOOK_YAML })
      vi.mocked(runE2eScenario)
        .mockResolvedValueOnce(passManifest('login-remember-me'))
        .mockRejectedValueOnce(new Error('Playwright MCP connection timeout'))
        .mockResolvedValueOnce(passManifest('login-session-expire'))

      const exec = getExecutor('qi_e2e_runner')!
      const result = await exec.execute(
        {
          requirementId: MOCK_REQUIREMENT_ID,
          worktreePath: wt,
          branch: `feat/qi-${MOCK_REQUIREMENT_ID}`,
          bareRepoPath: '/tmp/bare-qi-101',
        },
        makeCtx(),
      )

      // teardown 依然被调用
      expect(vi.mocked(teardownQiSandbox)).toHaveBeenCalledOnce()
      expect(result.output.result).toBe('fail')
      expect(result.output.scenariosRun).toBe(3)
      expect(result.output.failed).toBe(1)

      const fr = result.output.failureReport as {
        scenarios: Array<{ id: string; failureReason: string; result: string }>
      }
      expect(fr.scenarios[0].id).toBe('login-wrong-password')
      expect(fr.scenarios[0].failureReason).toContain('Playwright MCP connection timeout')
      expect(fr.scenarios[0].result).toBe('no-manifest')
    })
  })

  // ─── 场景 C: 第 2 次 attempt 仍失败 → 升级 IM 人工介入 ────────────────
  describe('场景 C: 第 2 次 attempt — fail → e2e_im_intervention（超预算）', () => {
    it('ctx.steps 里有上次 attempt=1 → 本次 attempt=2，e2e_router 读到后走人工介入', async () => {
      const wt = makeWorktree({ playbookYaml: REALISTIC_PLAYBOOK_YAML })
      // 两个 scenario 都 fail，模拟修复后仍未解决
      vi.mocked(runE2eScenario)
        .mockResolvedValueOnce(
          failManifest('login-remember-me', 2, 'token 过期时间仍为 1 天，期望 7 天'),
        )
        .mockResolvedValueOnce(passManifest('login-wrong-password', 2))
        .mockResolvedValueOnce(passManifest('login-session-expire', 2))

      const exec = getExecutor('qi_e2e_runner')!
      const result = await exec.execute(
        {
          requirementId: MOCK_REQUIREMENT_ID,
          worktreePath: wt,
          branch: `feat/qi-${MOCK_REQUIREMENT_ID}`,
          bareRepoPath: '/tmp/bare-qi-101',
        },
        // ctx.steps 包含上次节点输出（fix-loop 回环后）
        makeCtx({
          steps: {
            qi_e2e_runner: {
              status: 'success',
              output: { result: 'fail', attempt: 1, scenariosRun: 3, passed: 2, failed: 1 },
            },
          } as never,
        }),
      )

      // attempt 应自动加 1
      expect(result.output.attempt).toBe(2)
      expect(result.output.result).toBe('fail')
      // e2e_router 会根据 attempt=2 && result='fail' → e2e_im_intervention
      // （节点自身不决策路由，只输出数据）
      const fr = result.output.failureReport as { scenarios: Array<{ id: string }> }
      expect(fr.scenarios[0].id).toBe('login-remember-me')
    })
  })

  // ─── 场景 D: Sandbox 基础设施失败 → e2e_sandbox_intervention ──────────
  describe('场景 D: Sandbox provision 失败 → e2e_sandbox_intervention', () => {
    it('git-clone 阶段失败 → result=sandbox_failed, teardown 不被调用', async () => {
      const wt = makeWorktree({ playbookYaml: REALISTIC_PLAYBOOK_YAML })
      vi.mocked(provisionQiSandbox).mockRejectedValueOnce(
        new SandboxProvisionError(
          'git-clone',
          'fatal: repository "/tmp/bare-qi-101" does not exist',
        ),
      )

      const exec = getExecutor('qi_e2e_runner')!
      const result = await exec.execute(
        {
          requirementId: MOCK_REQUIREMENT_ID,
          worktreePath: wt,
          branch: `feat/qi-${MOCK_REQUIREMENT_ID}`,
          bareRepoPath: '/tmp/bare-qi-101',
        },
        makeCtx(),
      )

      expect(result.status).toBe('failed')
      expect(result.output.result).toBe('sandbox_failed')
      expect(result.output.attempt).toBe(1)
      expect(result.output.sandboxError).toContain('git-clone')
      expect(result.output.sandboxError).toContain('does not exist')
      // provision 失败时 teardown 不应被调（没有 handle）
      expect(vi.mocked(teardownQiSandbox)).not.toHaveBeenCalled()
      // scenario runner 也不应被调
      expect(vi.mocked(runE2eScenario)).not.toHaveBeenCalled()
    })

    it('deploy.sh provision 超时/失败 → result=sandbox_failed', async () => {
      const wt = makeWorktree({ playbookYaml: REALISTIC_PLAYBOOK_YAML })
      vi.mocked(provisionQiSandbox).mockRejectedValueOnce(
        new SandboxProvisionError(
          'deploy-provision',
          'deploy.sh provision exited 1: ERROR: 数据库连接失败，PG_HOST=postgres 无法访问',
        ),
      )

      const exec = getExecutor('qi_e2e_runner')!
      const result = await exec.execute(
        {
          requirementId: MOCK_REQUIREMENT_ID,
          worktreePath: wt,
          branch: `feat/qi-${MOCK_REQUIREMENT_ID}`,
          bareRepoPath: '/tmp/bare-qi-101',
        },
        makeCtx(),
      )

      expect(result.output.result).toBe('sandbox_failed')
      expect(result.output.sandboxError).toContain('deploy-provision')
      expect(vi.mocked(teardownQiSandbox)).not.toHaveBeenCalled()
    })

    it('push to bare 失败 → result=sandbox_failed，在 provision 之前短路', async () => {
      const wt = makeWorktree({ playbookYaml: REALISTIC_PLAYBOOK_YAML })
      vi.mocked(pushToBare).mockRejectedValueOnce(
        new Error('bare repo not initialized: /tmp/bare-qi-101'),
      )

      const exec = getExecutor('qi_e2e_runner')!
      const result = await exec.execute(
        {
          requirementId: MOCK_REQUIREMENT_ID,
          worktreePath: wt,
          branch: `feat/qi-${MOCK_REQUIREMENT_ID}`,
          bareRepoPath: '/tmp/bare-qi-101',
        },
        makeCtx(),
      )

      expect(result.output.result).toBe('sandbox_failed')
      expect(result.output.sandboxError).toContain('push to bare failed')
      // push 失败后不进入 provision
      expect(vi.mocked(provisionQiSandbox)).not.toHaveBeenCalled()
    })

    it('e2e_target_projects 里没有配置该项目 → result=sandbox_failed', async () => {
      const wt = makeWorktree({ playbookYaml: REALISTIC_PLAYBOOK_YAML })
      vi.mocked(listE2eTargetProjects).mockResolvedValueOnce([]) // 清空，没有匹配项目

      const exec = getExecutor('qi_e2e_runner')!
      const result = await exec.execute(
        {
          requirementId: MOCK_REQUIREMENT_ID,
          worktreePath: wt,
          branch: `feat/qi-${MOCK_REQUIREMENT_ID}`,
          bareRepoPath: '/tmp/bare-qi-101',
        },
        makeCtx(),
      )

      expect(result.output.result).toBe('sandbox_failed')
      expect(result.output.sandboxError).toContain('no e2e_target_projects matches')
      expect(result.output.sandboxError).toContain('PAM/devops/chatops')
      expect(vi.mocked(provisionQiSandbox)).not.toHaveBeenCalled()
    })
  })

  // ─── 场景 E: 无 Playbook — 跳过 E2E ──────────────────────────────────
  describe('场景 E: 没有生成 playbook（纯配置改动）→ 跳过 E2E，标记 skipped', () => {
    it('worktree 里无 playbook YAML → result=skipped, skipped=true, 不调 sandbox', async () => {
      const wt = makeWorktree() // 不写 playbook 文件

      const exec = getExecutor('qi_e2e_runner')!
      const result = await exec.execute(
        {
          requirementId: MOCK_REQUIREMENT_ID,
          worktreePath: wt,
          branch: `feat/qi-${MOCK_REQUIREMENT_ID}`,
          bareRepoPath: '/tmp/bare-qi-101',
        },
        makeCtx(),
      )

      expect(result.status).toBe('success')
      expect(result.output.result).toBe('skipped')
      expect(result.output.skipped).toBe(true)
      expect(result.output.scenariosRun).toBe(0)
      expect(result.output.passed).toBe(0)
      expect(result.output.failed).toBe(0)
      // skip 时什么都不启动
      expect(vi.mocked(provisionQiSandbox)).not.toHaveBeenCalled()
      expect(vi.mocked(runE2eScenario)).not.toHaveBeenCalled()
    })

    it('playbook scenarios 超过 5 个 → 合规校验拒绝，返回 fail（不是 skip）', async () => {
      const overflowYaml = `
specPath: docs/specs/qi-101.md
scenarios:
${Array.from({ length: 6 }, (_, i) => `  - id: s${i}
    name: scenario ${i}
    tags: []
    steps: ["访问 /api"]
    acceptance: [{ kind: url_match, value: /ok }]
`).join('')}
`
      const wt = makeWorktree({ playbookYaml: overflowYaml })
      const exec = getExecutor('qi_e2e_runner')!
      const result = await exec.execute(
        {
          requirementId: MOCK_REQUIREMENT_ID,
          worktreePath: wt,
          branch: `feat/qi-${MOCK_REQUIREMENT_ID}`,
          bareRepoPath: '/tmp/bare-qi-101',
        },
        makeCtx(),
      )

      expect(result.output.result).toBe('fail')
      const fr = result.output.failureReport as { scenarios: Array<{ failureReason: string }> }
      expect(fr.scenarios[0].failureReason).toContain('max 5')
      expect(vi.mocked(provisionQiSandbox)).not.toHaveBeenCalled()
    })
  })

  // ─── Fix-loop 全流程 (B→修复→C→pass) ─────────────────────────────────
  describe('Fix-loop 全流程：第 1 次 fail → dev-loop 修复 → 第 2 次 pass', () => {
    it('两次执行模拟：attempt=1 fail → attempt=2 pass，计数各自独立', async () => {
      const wt = makeWorktree({ playbookYaml: REALISTIC_PLAYBOOK_YAML })
      const exec = getExecutor('qi_e2e_runner')!

      // ── 第 1 次执行（attempt=1，login-wrong-password fail）──
      vi.mocked(runE2eScenario)
        .mockResolvedValueOnce(passManifest('login-remember-me', 1))
        .mockResolvedValueOnce(
          failManifest('login-wrong-password', 1, '提示文字未出现，实际看到 500 错误页'),
        )
        .mockResolvedValueOnce(passManifest('login-session-expire', 1))

      const result1 = await exec.execute(
        {
          requirementId: MOCK_REQUIREMENT_ID,
          worktreePath: wt,
          branch: `feat/qi-${MOCK_REQUIREMENT_ID}`,
          bareRepoPath: '/tmp/bare-qi-101',
        },
        makeCtx(),
      )

      expect(result1.output.attempt).toBe(1)
      expect(result1.output.result).toBe('fail')
      expect(result1.output.passed).toBe(2)
      expect(result1.output.failed).toBe(1)

      // ── 第 2 次执行（模拟 dev-loop 修复后 fix-loop 重入，attempt=2）──
      vi.mocked(runE2eScenario).mockReset()
      vi.mocked(provisionQiSandbox).mockReset().mockResolvedValue({
        ...SANDBOX_HANDLE,
        envId: 'env-qi-101-attempt-2',
        attempt: 2,
      })
      vi.mocked(runE2eScenario)
        .mockResolvedValueOnce(passManifest('login-remember-me', 2))
        .mockResolvedValueOnce(passManifest('login-wrong-password', 2))
        .mockResolvedValueOnce(passManifest('login-session-expire', 2))

      const result2 = await exec.execute(
        {
          requirementId: MOCK_REQUIREMENT_ID,
          worktreePath: wt,
          branch: `feat/qi-${MOCK_REQUIREMENT_ID}`,
          bareRepoPath: '/tmp/bare-qi-101',
        },
        // ctx.steps 带上一次的结果，模拟 fix-loop 回环
        makeCtx({
          steps: {
            qi_e2e_runner: {
              status: 'success',
              output: { ...result1.output },
            },
          } as never,
        }),
      )

      expect(result2.output.attempt).toBe(2) // 自动 +1
      expect(result2.output.result).toBe('pass')
      expect(result2.output.passed).toBe(3)
      expect(result2.output.failed).toBe(0)
      expect(result2.output.failureReport).toBeNull()
    })
  })
})
