// src/__tests__/integration/pipeline-b-graph.test.ts
//
// Pipeline B 图集成测试：mock 所有节点，验证图路由逻辑正确。
// 不依赖真实 DB/Docker，使用 CI=true 跑（无 testcontainer）。

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock all node modules — must appear before any imports of the graph
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

vi.mock('../../e2e/pipeline-b/nodes/discover.js', () => ({
  discoverNode: vi.fn(),
}))

vi.mock('../../e2e/pipeline-b/nodes/pick-next-scenario.js', () => ({
  pickNextScenarioNode: vi.fn(),
}))

vi.mock('../../e2e/pipeline-b/nodes/run-scenario.js', () => ({
  runScenarioNode: vi.fn(),
}))

vi.mock('../../e2e/pipeline-b/nodes/await-human-review.js', () => ({
  awaitHumanReviewNode: vi.fn(),
}))

vi.mock('../../e2e/pipeline-b/nodes/reset-iteration-branch.js', () => ({
  resetIterationBranchNode: vi.fn(),
}))

vi.mock('../../e2e/pipeline-b/nodes/e2e-fix-agent.js', () => ({
  e2eFixAgentNode: vi.fn(),
}))

vi.mock('../../e2e/pipeline-b/nodes/redeploy.js', () => ({
  redeployNode: vi.fn(),
}))

vi.mock('../../e2e/pipeline-b/nodes/healthcheck.js', () => ({
  healthcheckNode: vi.fn(),
}))

vi.mock('../../e2e/pipeline-b/nodes/mark-green.js', () => ({
  markGreenNode: vi.fn(),
}))

vi.mock('../../e2e/pipeline-b/nodes/mark-unfixable.js', () => ({
  markUnfixableNode: vi.fn(),
}))

vi.mock('../../e2e/pipeline-b/nodes/create-summary-mr.js', () => ({
  createSummaryMrNode: vi.fn(),
}))

vi.mock('../../e2e/pipeline-b/nodes/finalize-failed.js', () => ({
  finalizeFailedNode: vi.fn(),
}))

vi.mock('../../e2e/pipeline-b/nodes/teardown-sandbox.js', () => ({
  teardownSandboxNode: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Imports (after vi.mock hoisting)
// ---------------------------------------------------------------------------

import { buildPipelineBGraph } from '../../e2e/pipeline-b/graph.js'
import { initRunNode } from '../../e2e/pipeline-b/nodes/init-run.js'
import { setupSandboxNode } from '../../e2e/pipeline-b/nodes/setup-sandbox.js'
import { deployInitialNode } from '../../e2e/pipeline-b/nodes/deploy-initial.js'
import { discoverNode } from '../../e2e/pipeline-b/nodes/discover.js'
import { pickNextScenarioNode } from '../../e2e/pipeline-b/nodes/pick-next-scenario.js'
import { runScenarioNode } from '../../e2e/pipeline-b/nodes/run-scenario.js'
import { awaitHumanReviewNode } from '../../e2e/pipeline-b/nodes/await-human-review.js'
import { resetIterationBranchNode } from '../../e2e/pipeline-b/nodes/reset-iteration-branch.js'
import { e2eFixAgentNode } from '../../e2e/pipeline-b/nodes/e2e-fix-agent.js'
import { redeployNode } from '../../e2e/pipeline-b/nodes/redeploy.js'
import { healthcheckNode } from '../../e2e/pipeline-b/nodes/healthcheck.js'
import { markGreenNode } from '../../e2e/pipeline-b/nodes/mark-green.js'
import { markUnfixableNode } from '../../e2e/pipeline-b/nodes/mark-unfixable.js'
import { createSummaryMrNode } from '../../e2e/pipeline-b/nodes/create-summary-mr.js'
import { finalizeFailedNode } from '../../e2e/pipeline-b/nodes/finalize-failed.js'
import { teardownSandboxNode } from '../../e2e/pipeline-b/nodes/teardown-sandbox.js'
import type { GovernorState, ScenarioInfo } from '../../e2e/pipeline-b/types.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SANDBOX_HANDLE = {
  envId: 'test-env-1',
  kind: 'docker-compose-local',
  endpoints: { api: 'http://localhost:13001' },
  internalRefs: {},
  containerId: 'abc123',
  workdir: '/workspace/chatops',
}

function baseGovernorState(): GovernorState {
  return {
    runStartedAt: Date.now(),
    totalAttempts: 0,
    totalElapsedMs: 0,
    perScenarioAttempts: {} as Record<string, number>,
    limits: {
      maxPerScenarioAttempts: 3,
      maxRunHours: 4,
      maxTotalAttempts: 30,
      maxQueuedRuns: 2,
    },
  }
}

const SCENARIO_A: ScenarioInfo = { id: 'login-success', name: 'Login', tags: ['smoke'] }
const SCENARIO_B: ScenarioInfo = { id: 'create-prd', name: 'Create PRD', tags: ['core'] }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build and run the compiled graph with given initial state patch.
 * All node mocks must be set up before calling this.
 */
async function runGraph(initialInput: Record<string, unknown>) {
  const graph = buildPipelineBGraph()
  const result = await graph.invoke(initialInput)
  return result
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()

  // Default: all node mocks return empty patches (no state changes)
  vi.mocked(initRunNode).mockResolvedValue({})
  vi.mocked(setupSandboxNode).mockResolvedValue({})
  vi.mocked(deployInitialNode).mockResolvedValue({})
  vi.mocked(discoverNode).mockResolvedValue({})
  vi.mocked(pickNextScenarioNode).mockResolvedValue({})
  vi.mocked(runScenarioNode).mockResolvedValue({})
  vi.mocked(awaitHumanReviewNode).mockResolvedValue({})
  vi.mocked(resetIterationBranchNode).mockResolvedValue({})
  vi.mocked(e2eFixAgentNode).mockResolvedValue({ lastFixResult: {} as any })
  vi.mocked(redeployNode).mockResolvedValue({})
  vi.mocked(healthcheckNode).mockResolvedValue({})
  vi.mocked(markGreenNode).mockResolvedValue({})
  vi.mocked(markUnfixableNode).mockResolvedValue({})
  vi.mocked(createSummaryMrNode).mockResolvedValue({})
  vi.mocked(finalizeFailedNode).mockResolvedValue({})
  vi.mocked(teardownSandboxNode).mockResolvedValue({})
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Pipeline B graph routing', () => {
  // -------------------------------------------------------------------------
  // 1. 全绿路径：所有 scenario 初始就 pass
  // -------------------------------------------------------------------------
  it('全绿路径：2 个 scenario 全 pass → createSummaryMrNode 1 次, teardownSandboxNode 1 次', async () => {
    const governor = baseGovernorState()

    // discover → returns 2 pending scenarios
    vi.mocked(discoverNode).mockResolvedValue({
      pendingScenarios: [SCENARIO_A, SCENARIO_B],
    })

    // pick_next_scenario: first call returns SCENARIO_A (pending=[A,B]), second returns SCENARIO_B (pending=[B])
    vi.mocked(pickNextScenarioNode)
      .mockResolvedValueOnce({ currentScenario: SCENARIO_A })
      .mockResolvedValueOnce({ currentScenario: SCENARIO_B })

    // run_scenario: both pass
    vi.mocked(runScenarioNode)
      .mockResolvedValueOnce({
        lastScenarioResult: 'pass',
        governorState: { ...governor, totalAttempts: 1, perScenarioAttempts: { [SCENARIO_A.id]: 1 } },
      })
      .mockResolvedValueOnce({
        lastScenarioResult: 'pass',
        governorState: { ...governor, totalAttempts: 2, perScenarioAttempts: { [SCENARIO_A.id]: 1, [SCENARIO_B.id]: 1 } },
      })

    // mark_green: first removes A (pending=[B]), second removes B (pending=[])
    vi.mocked(markGreenNode)
      .mockResolvedValueOnce({
        pendingScenarios: [SCENARIO_B],
        currentScenario: null,
        lastScenarioResult: null,
        evidenceDirTemp: null,
      })
      .mockResolvedValueOnce({
        pendingScenarios: [],
        currentScenario: null,
        lastScenarioResult: null,
        evidenceDirTemp: null,
      })

    await runGraph({
      runId: 1n,
      targetProjectId: 'chatops',
      sourceBranch: 'main',
      iterationBranch: 'test-iter/1',
      sandboxHandle: SANDBOX_HANDLE,
      governorState: governor,
    })

    expect(createSummaryMrNode).toHaveBeenCalledTimes(1)
    expect(teardownSandboxNode).toHaveBeenCalledTimes(1)
    expect(finalizeFailedNode).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // 2. 修复路径：1 次失败 → fix 成功 → redeploy → pass
  // -------------------------------------------------------------------------
  it('修复路径：fail → fix success → redeploy → pass → createSummaryMrNode', async () => {
    const governor = baseGovernorState()

    vi.mocked(discoverNode).mockResolvedValue({
      pendingScenarios: [SCENARIO_A],
    })

    vi.mocked(pickNextScenarioNode)
      // First time: pick SCENARIO_A
      .mockResolvedValueOnce({ currentScenario: SCENARIO_A })
      // Second time (after redeploy + healthcheck): pick SCENARIO_A again
      .mockResolvedValueOnce({ currentScenario: SCENARIO_A })

    vi.mocked(runScenarioNode)
      // First run: fail
      .mockResolvedValueOnce({
        lastScenarioResult: 'fail',
        currentScenarioRunId: 100n,
        governorState: { ...governor, totalAttempts: 1, perScenarioAttempts: { [SCENARIO_A.id]: 1 } },
      })
      // Second run (after fix+redeploy): pass
      .mockResolvedValueOnce({
        lastScenarioResult: 'pass',
        governorState: { ...governor, totalAttempts: 2, perScenarioAttempts: { [SCENARIO_A.id]: 2 } },
      })

    // await_human_review: 模拟用户回 approve（同意进 fix-agent）
    vi.mocked(awaitHumanReviewNode).mockResolvedValue({ humanReviewDecision: 'approve' })
    vi.mocked(resetIterationBranchNode).mockResolvedValue({})

    // fix agent: success
    vi.mocked(e2eFixAgentNode).mockResolvedValue({
      lastFixResult: {
        verdict: 'product_bug',
        rootCauseSummary: 'null pointer',
        fixCommitSha: 'abc123',
        fixedFiles: ['src/foo.ts'],
        success: true,
        failureReason: '',
      },
    })

    vi.mocked(redeployNode).mockResolvedValue({})
    vi.mocked(healthcheckNode).mockResolvedValue({})

    // mark_green: removes SCENARIO_A, pending=[]
    vi.mocked(markGreenNode).mockResolvedValueOnce({
      pendingScenarios: [],
      currentScenario: null,
      lastScenarioResult: null,
      evidenceDirTemp: null,
    })

    await runGraph({
      runId: 2n,
      targetProjectId: 'chatops',
      sourceBranch: 'main',
      iterationBranch: 'test-iter/2',
      sandboxHandle: SANDBOX_HANDLE,
      governorState: governor,
    })

    expect(e2eFixAgentNode).toHaveBeenCalledTimes(1)
    expect(redeployNode).toHaveBeenCalledTimes(1)
    expect(healthcheckNode).toHaveBeenCalledTimes(1)
    expect(createSummaryMrNode).toHaveBeenCalledTimes(1)
    expect(finalizeFailedNode).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // 3. mark_unfixable 路径：fix 失败 → markUnfixableNode → finalizeFailedNode
  // -------------------------------------------------------------------------
  it('mark_unfixable 路径：fix 失败 → markUnfixableNode → finalizeFailedNode（非 createSummaryMrNode）', async () => {
    const governor = baseGovernorState()

    vi.mocked(discoverNode).mockResolvedValue({
      pendingScenarios: [SCENARIO_A],
    })

    vi.mocked(pickNextScenarioNode).mockResolvedValueOnce({ currentScenario: SCENARIO_A })

    vi.mocked(runScenarioNode).mockResolvedValueOnce({
      lastScenarioResult: 'fail',
      currentScenarioRunId: 200n,
      governorState: { ...governor, totalAttempts: 1, perScenarioAttempts: { [SCENARIO_A.id]: 1 } },
    })

    vi.mocked(awaitHumanReviewNode).mockResolvedValue({})
    vi.mocked(resetIterationBranchNode).mockResolvedValue({})

    // fix agent: failure
    vi.mocked(e2eFixAgentNode).mockResolvedValue({
      lastFixResult: {
        verdict: 'uncertain',
        rootCauseSummary: 'unknown',
        fixCommitSha: null,
        fixedFiles: [],
        success: false,
        failureReason: 'could not determine fix',
      },
    })

    // markUnfixable removes SCENARIO_A, pending=[]
    vi.mocked(markUnfixableNode).mockResolvedValueOnce({
      pendingScenarios: [],
      currentScenario: null,
      lastFixResult: null,
    })

    await runGraph({
      runId: 3n,
      targetProjectId: 'chatops',
      sourceBranch: 'main',
      iterationBranch: 'test-iter/3',
      sandboxHandle: SANDBOX_HANDLE,
      governorState: governor,
    })

    expect(markUnfixableNode).toHaveBeenCalledTimes(1)
    expect(finalizeFailedNode).toHaveBeenCalledTimes(1)
    expect(createSummaryMrNode).not.toHaveBeenCalled()
    expect(teardownSandboxNode).toHaveBeenCalledTimes(1)
  })

  // -------------------------------------------------------------------------
  // 4. governor 超限（totalAttempts）→ finalizeFailedNode
  // -------------------------------------------------------------------------
  it('governor 超限（totalAttempts >= maxTotalAttempts）→ over_budget → finalizeFailedNode', async () => {
    // Governor at limit from the start (before any scenario runs)
    const governor = {
      ...baseGovernorState(),
      totalAttempts: 30, // equals maxTotalAttempts
    }

    vi.mocked(discoverNode).mockResolvedValue({
      pendingScenarios: [SCENARIO_A],
    })

    // Provide the over-budget governor in state so mainSwitchRoute sees it
    await runGraph({
      runId: 4n,
      targetProjectId: 'chatops',
      sourceBranch: 'main',
      iterationBranch: 'test-iter/4',
      sandboxHandle: SANDBOX_HANDLE,
      governorState: governor,
    })

    expect(finalizeFailedNode).toHaveBeenCalledTimes(1)
    expect(createSummaryMrNode).not.toHaveBeenCalled()
    expect(teardownSandboxNode).toHaveBeenCalledTimes(1)
  })

  // -------------------------------------------------------------------------
  // 5. governor 超限（maxRunHours）→ finalizeFailedNode
  // -------------------------------------------------------------------------
  it('governor 超限（maxRunHours 超时）→ over_budget → finalizeFailedNode', async () => {
    const governor = {
      ...baseGovernorState(),
      runStartedAt: Date.now() - 5 * 3600 * 1000, // 5 hours ago (limit=4h)
    }

    vi.mocked(discoverNode).mockResolvedValue({
      pendingScenarios: [SCENARIO_A],
    })

    await runGraph({
      runId: 5n,
      targetProjectId: 'chatops',
      sourceBranch: 'main',
      iterationBranch: 'test-iter/5',
      sandboxHandle: SANDBOX_HANDLE,
      governorState: governor,
    })

    expect(finalizeFailedNode).toHaveBeenCalledTimes(1)
    expect(createSummaryMrNode).not.toHaveBeenCalled()
    expect(teardownSandboxNode).toHaveBeenCalledTimes(1)
  })

  // -------------------------------------------------------------------------
  // 6. 空 scenario 列表 → createSummaryMrNode（无需跑任何场景）
  // -------------------------------------------------------------------------
  it('空 scenario 列表 → 直接走 all_passed → createSummaryMrNode', async () => {
    const governor = baseGovernorState()

    // discover returns empty list
    vi.mocked(discoverNode).mockResolvedValue({
      pendingScenarios: [],
    })

    await runGraph({
      runId: 6n,
      targetProjectId: 'chatops',
      sourceBranch: 'main',
      iterationBranch: 'test-iter/6',
      sandboxHandle: SANDBOX_HANDLE,
      governorState: governor,
    })

    expect(createSummaryMrNode).toHaveBeenCalledTimes(1)
    expect(pickNextScenarioNode).not.toHaveBeenCalled()
    expect(runScenarioNode).not.toHaveBeenCalled()
    expect(finalizeFailedNode).not.toHaveBeenCalled()
    expect(teardownSandboxNode).toHaveBeenCalledTimes(1)
  })
})
