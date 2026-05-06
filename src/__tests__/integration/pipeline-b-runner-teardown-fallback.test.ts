// src/__tests__/integration/pipeline-b-runner-teardown-fallback.test.ts
//
// 验证 runner.ts catch 路径在 graph 抛错时能用 DB 重建 sandboxHandle 调 teardown。
// LangGraph 的 invoke 不把节点中间 state 回流给外层闭包，所以 runner 必须从
// e2e_sandboxes 表回查；这个测试断言 catch 路径调用 teardownSandboxNode 时
// 收到的 state 含 sandboxHandle，覆盖 fix 的 wiring。
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// vi.mock 必须在 import runner 之前
// ---------------------------------------------------------------------------

vi.mock('../../e2e/pipeline-b/nodes/init-run.js', () => ({
  initRunNode: vi.fn(),
}))
vi.mock('../../e2e/pipeline-b/nodes/setup-sandbox.js', () => ({
  setupSandboxNode: vi.fn(),
}))
vi.mock('../../e2e/pipeline-b/nodes/deploy-initial.js', () => ({
  deployInitialNode: vi.fn(),
}))
vi.mock('../../e2e/pipeline-b/nodes/teardown-sandbox.js', () => ({
  teardownSandboxNode: vi.fn(),
}))
// 下游节点不会被到达，但要 mock 防止真实模块的 import 副作用
vi.mock('../../e2e/pipeline-b/nodes/discover.js', () => ({ discoverNode: vi.fn() }))
vi.mock('../../e2e/pipeline-b/nodes/pick-next-scenario.js', () => ({ pickNextScenarioNode: vi.fn() }))
vi.mock('../../e2e/pipeline-b/nodes/run-scenario.js', () => ({ runScenarioNode: vi.fn() }))
vi.mock('../../e2e/pipeline-b/nodes/await-human-review.js', () => ({ awaitHumanReviewNode: vi.fn() }))
vi.mock('../../e2e/pipeline-b/nodes/reset-iteration-branch.js', () => ({ resetIterationBranchNode: vi.fn() }))
vi.mock('../../e2e/pipeline-b/nodes/e2e-fix-agent.js', () => ({ e2eFixAgentNode: vi.fn() }))
vi.mock('../../e2e/pipeline-b/nodes/redeploy.js', () => ({ redeployNode: vi.fn() }))
vi.mock('../../e2e/pipeline-b/nodes/healthcheck.js', () => ({ healthcheckNode: vi.fn() }))
vi.mock('../../e2e/pipeline-b/nodes/mark-green.js', () => ({ markGreenNode: vi.fn() }))
vi.mock('../../e2e/pipeline-b/nodes/mark-unfixable.js', () => ({ markUnfixableNode: vi.fn() }))
vi.mock('../../e2e/pipeline-b/nodes/create-summary-mr.js', () => ({ createSummaryMrNode: vi.fn() }))
vi.mock('../../e2e/pipeline-b/nodes/finalize-failed.js', () => ({ finalizeFailedNode: vi.fn() }))

import { resetTestDb } from '../helpers/db.js'
import { runPipelineB } from '../../e2e/pipeline-b/runner.js'
import { initRunNode } from '../../e2e/pipeline-b/nodes/init-run.js'
import { setupSandboxNode } from '../../e2e/pipeline-b/nodes/setup-sandbox.js'
import { deployInitialNode } from '../../e2e/pipeline-b/nodes/deploy-initial.js'
import { teardownSandboxNode } from '../../e2e/pipeline-b/nodes/teardown-sandbox.js'
import { createSandbox, updateSandboxStatus } from '../../db/repositories/e2e-sandboxes.js'
import { createE2eRun, getE2eRun } from '../../db/repositories/e2e-runs.js'
import type { SandboxHandle } from '../../e2e/pipeline-b/types.js'

describe('Pipeline B runner: catch 路径 DB-fallback teardown', () => {
  beforeEach(async () => {
    await resetTestDb()
    vi.clearAllMocks()
    // 所有节点默认 resolve 空 partial state；测试用例覆盖关心的节点
    // （vi.fn() 默认返回 undefined，runner.ts catch 路径会对 teardownSandboxNode
    //  返回值调 .catch，必须给个 Promise）
    vi.mocked(initRunNode).mockResolvedValue({})
    vi.mocked(setupSandboxNode).mockResolvedValue({})
    vi.mocked(deployInitialNode).mockResolvedValue({})
    vi.mocked(teardownSandboxNode).mockResolvedValue({})
  })

  it('graph 在 deploy_initial 抛错时，catch 路径用 DB 重建 sandboxHandle 调 teardown', async () => {
    // arrange: 预创建 e2e_run（与生产 caller 一致：admin/coordinator 都传 existingRunId）
    const run = await createE2eRun({
      targetProjectId: 'chatops',
      triggerType: 'api',
      triggerActor: null,
      sourceBranch: 'main',
      iterationBranch: 'test-iter/fallback',
      scenarioFilter: null,
    })

    // init_run mock：不真跑 git，只回 partial state（runner 已经把 runId 作为 existingRunId 传入）
    vi.mocked(initRunNode).mockResolvedValue({
      iterationBranch: 'test-iter/fallback',
      projectScripts: { build: 'build.sh', deploy: 'deploy.sh', test: 'test.sh' },
    })

    // setup_sandbox mock：模拟生产行为 —— 写 e2e_sandboxes 表 + 返回 sandboxHandle 给 graph
    // （但 LangGraph invoke 抛错时这个返回值不会回流给 runner 的 lastKnownState）
    const NETWORK_NAME = 'chatops-e2e-sandbox-fallback-test'
    vi.mocked(setupSandboxNode).mockImplementation(async (state) => {
      const handle: SandboxHandle = {
        envId: `test-env-${state.runId}`,
        kind: 'docker-compose-local',
        endpoints: { web_base_url: 'http://chatops-e2e-9999:3000' },
        internalRefs: {
          network: NETWORK_NAME,
          apiPort: 9999,
          runId: String(state.runId),
        },
      }
      const sb = await createSandbox({
        e2eRunId: state.runId,
        kind: 'docker-compose-local',
        handle: handle as unknown as Parameters<typeof createSandbox>[0]['handle'],
      })
      await updateSandboxStatus(sb.id, 'ready', { readyAt: new Date() })
      return { sandboxId: sb.id, sandboxHandle: handle }
    })

    // deploy_initial mock：抛错 → graph.invoke throws → runner catch 路径
    vi.mocked(deployInitialNode).mockRejectedValue(
      new Error('deploy failed (test fixture)'),
    )

    // act
    await expect(
      runPipelineB({
        targetProjectId: 'chatops',
        sourceBranch: 'main',
        triggerType: 'api',
        existingRunId: run.id,
      }),
    ).rejects.toThrow(/deploy failed/)

    // assert: catch 路径调 teardown 时收到的 state 必须含 sandboxHandle（来自 DB 回查）
    expect(vi.mocked(teardownSandboxNode)).toHaveBeenCalled()
    const teardownCalls = vi.mocked(teardownSandboxNode).mock.calls
    expect(teardownCalls.length).toBeGreaterThanOrEqual(1)

    // catch 路径是最后一次调用（graph 没走到正常 teardown_sandbox 节点，所以唯一一次也是 catch 路径）
    const stateArg = teardownCalls[teardownCalls.length - 1][0]
    expect(stateArg.sandboxHandle).toBeTruthy()
    expect(stateArg.sandboxHandle).not.toBeNull()
    expect(
      (stateArg.sandboxHandle as SandboxHandle).internalRefs.network,
    ).toBe(NETWORK_NAME)
    expect(stateArg.sandboxId).toBeTruthy()

    // 兼带验证：e2e_run.status 已被 catch 路径设为 aborted（既有行为）
    const updated = await getE2eRun(run.id)
    expect(updated?.status).toBe('aborted')
  })

  it('DB 中 sandbox.status=torn_down 时，catch 路径不重复调 teardown（避免重复清理）', async () => {
    const run = await createE2eRun({
      targetProjectId: 'chatops',
      triggerType: 'api',
      triggerActor: null,
      sourceBranch: 'main',
      iterationBranch: 'test-iter/fallback-already-torn',
      scenarioFilter: null,
    })

    vi.mocked(initRunNode).mockResolvedValue({
      iterationBranch: 'test-iter/fallback-already-torn',
      projectScripts: { build: 'build.sh', deploy: 'deploy.sh', test: 'test.sh' },
    })

    // setup_sandbox 写 sandbox 但立刻置 torn_down（模拟 sandbox 已经被另一条路径清完的边缘）
    vi.mocked(setupSandboxNode).mockImplementation(async (state) => {
      const handle: SandboxHandle = {
        envId: `test-env-${state.runId}`,
        kind: 'docker-compose-local',
        endpoints: { web_base_url: 'http://test:3000' },
        internalRefs: { network: 'already-torn-net', apiPort: 9998, runId: String(state.runId) },
      }
      const sb = await createSandbox({
        e2eRunId: state.runId,
        kind: 'docker-compose-local',
        handle: handle as unknown as Parameters<typeof createSandbox>[0]['handle'],
      })
      await updateSandboxStatus(sb.id, 'torn_down', { destroyedAt: new Date() })
      return { sandboxId: sb.id, sandboxHandle: handle }
    })

    vi.mocked(deployInitialNode).mockRejectedValue(new Error('deploy failed (test fixture)'))

    await expect(
      runPipelineB({
        targetProjectId: 'chatops',
        sourceBranch: 'main',
        triggerType: 'api',
        existingRunId: run.id,
      }),
    ).rejects.toThrow(/deploy failed/)

    // catch 路径仍会调一次 teardown（保留原有 best-effort 兜底语义），但此时 sandboxHandle 应为 null
    // —— rebuild helper 看到 status=torn_down 直接跳过 rebuild，让 teardown 节点早退
    expect(vi.mocked(teardownSandboxNode)).toHaveBeenCalled()
    const lastCall = vi.mocked(teardownSandboxNode).mock.calls.slice(-1)[0]
    expect(lastCall[0].sandboxHandle).toBeFalsy()
  })
})
