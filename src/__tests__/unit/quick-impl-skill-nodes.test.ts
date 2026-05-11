/**
 * Unit tests for the three Quick-Impl skill node builders:
 *   buildSkillNode, buildSkillWithApprovalNode, buildSkillWithReviewNode
 *
 * Strategy:
 *   - Run nodes through buildGraphFromPipeline + MemorySaver so the actual
 *     node functions execute (no hand-rolled state patching).
 *   - Mock runSkill (skill-runner) and DB calls (requirement-approval-waiters,
 *     stage-status) to eliminate all external I/O.
 *   - Mock `interrupt` from @langchain/langgraph to bypass the LangGraph
 *     interrupt mechanism for skill_with_approval decision tests — the mock
 *     returns a QiApprovalResume directly so the loop logic runs synchronously.
 */
import { vi, describe, it, expect, beforeEach, type MockedFunction } from 'vitest'
import { randomUUID } from 'node:crypto'
import { MemorySaver } from '@langchain/langgraph'

// ---- Module mocks (hoisted before imports) ----------------------------------

vi.mock('../../pipeline/stage-status.js', () => ({
  markStageRunning: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../db/repositories/requirement-approval-waiters.js', () => ({
  getWaiterByNodeAndRound: vi.fn(),
  createWaiter: vi.fn(),
}))

vi.mock('../../db/repositories/requirements.js', () => ({
  setRequirementStatus: vi.fn().mockResolvedValue(true),
}))

vi.mock('../../quick-impl/skill-runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../quick-impl/skill-runner.js')>()
  return { ...actual, runSkill: vi.fn() }
})

// Preserve all LangGraph internals but replace interrupt so it doesn't throw.
vi.mock('@langchain/langgraph', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@langchain/langgraph')>()
  return { ...actual, interrupt: vi.fn() }
})

// ---- Imports (after mocks) --------------------------------------------------

import { buildGraphFromPipeline, type StageHooks } from '../../pipeline/graph-builder.js'
import type { PipelineGraph, PipelineNode } from '../../pipeline/types.js'
import { runSkill } from '../../quick-impl/skill-runner.js'
import {
  getWaiterByNodeAndRound,
  createWaiter,
} from '../../db/repositories/requirement-approval-waiters.js'
import { setRequirementStatus } from '../../db/repositories/requirements.js'
import type { RunSkillResult } from '../../quick-impl/skill-runner.js'
import type { RequirementApprovalWaiter } from '../../db/repositories/requirement-approval-waiters.js'
import type { QiApprovalResume } from '../../pipeline/graph-builder.js'
import { interrupt } from '@langchain/langgraph'

const mockRunSkill = runSkill as MockedFunction<typeof runSkill>
const mockGetWaiterByNodeAndRound = getWaiterByNodeAndRound as MockedFunction<typeof getWaiterByNodeAndRound>
const mockCreateWaiter = createWaiter as MockedFunction<typeof createWaiter>
const mockInterrupt = interrupt as unknown as MockedFunction<() => QiApprovalResume>
const mockSetRequirementStatus = setRequirementStatus as MockedFunction<typeof setRequirementStatus>

// =============================================================================
// Helpers
// =============================================================================

const BASE_HOOKS: StageHooks = {
  runScript: async () => ({ status: 'success', output: '' }),
}

const BASE_CTX = {
  runId: 1,
  servers: {} as Record<string, never[]>,
  logDir: '/tmp/qi-test',
}

function makeNode(
  stageType: PipelineNode['stageType'],
  params: Record<string, unknown>,
): PipelineGraph['nodes'][number] {
  return {
    id: 'n1',
    name: 'test-node',
    stageType,
    params,
    targetRoles: [],
    parallel: false,
    timeoutSeconds: 60,
    retryCount: 0,
    onFailure: 'stop',
    position: { x: 0, y: 0 },
  } as PipelineGraph['nodes'][number]
}

function makeFakeSkillExecutor() {
  return { execute: vi.fn() }
}

async function runGraph(
  node: PipelineGraph['nodes'][number],
  skillExecutor?: ReturnType<typeof makeFakeSkillExecutor>,
) {
  const graph: PipelineGraph = { nodes: [node], edges: [] }
  const builder = buildGraphFromPipeline({
    graph,
    stageContext: { ...BASE_CTX, skillExecutor },
    hooks: BASE_HOOKS,
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = (builder as any).compile({ checkpointer: new MemorySaver() })
  const config = { configurable: { thread_id: randomUUID() } }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for await (const _ of await app.stream({ runId: 1 }, config)) { /* drain */ }
  return app.getState(config) as { values: Record<string, unknown> }
}

function makeSkillResult(
  override: Partial<RunSkillResult> = {},
): RunSkillResult {
  return {
    output: { summary: 'done', decision: undefined },
    rawOutput: '```json\n{"summary":"done"}\n```',
    durationMs: 100,
    inputTokens: 10,
    outputTokens: 20,
    ...override,
  }
}

function makeWaiterRow(
  override: Partial<RequirementApprovalWaiter> = {},
): RequirementApprovalWaiter {
  return {
    id: 99,
    requirementId: 1,
    pipelineRunId: 1,
    nodeId: 'n1',
    approvalKind: 'spec',
    round: 1,
    decisionSet: 'binary',
    imPlatform: null,
    imGroupId: null,
    contextSummary: null,
    claimedBy: 'web',
    claimedAt: new Date(),
    decision: 'approved',
    rejectReason: null,
    budgetDelta: null,
    decidedBy: 'alice',
    targetTaskId: null,
    citedAiNotes: null,
    createdAt: new Date(),
    ...override,
  }
}

function makeResume(
  decision: RequirementApprovalWaiter['decision'],
  extra: Partial<RequirementApprovalWaiter> = {},
): QiApprovalResume {
  return {
    claimedWaiter: makeWaiterRow({ decision, ...extra }),
    prevState: { budgetUsed: 0, rejectHistory: [] },
  }
}

// =============================================================================
// skill_node
// =============================================================================

describe('skill_node', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns failed when skillExecutor is not configured', async () => {
    const node = makeNode('skill_node', {
      requirementId: 1,
      skill: 'quick-impl-artifact-author',
      role: 'spec-author',
      worktreePath: '/tmp/wt',
      branch: 'qi/1',
      baseBranch: 'main',
      artifactPath: 'spec.md',
    })
    const snap = await runGraph(node, undefined)
    const results = snap.values.stageResults as Array<{ status: string; error?: string }>
    expect(results[0].status).toBe('failed')
    expect(results[0].error).toBe('no_skill_executor')
  })

  it('returns failed when required params are missing', async () => {
    const node = makeNode('skill_node', {
      requirementId: 1,
      // skill missing
      role: 'spec-author',
      worktreePath: '/tmp/wt',
      branch: 'qi/1',
      baseBranch: 'main',
      artifactPath: 'spec.md',
    })
    const snap = await runGraph(node, makeFakeSkillExecutor())
    const results = snap.values.stageResults as Array<{ status: string; error?: string }>
    expect(results[0].status).toBe('failed')
    expect(results[0].error).toBe('missing_params')
  })

  it('returns failed when runSkill throws', async () => {
    mockRunSkill.mockRejectedValueOnce(new Error('SkillNotFoundError: test-skill'))
    const node = makeNode('skill_node', {
      requirementId: 1,
      skill: 'test-skill',
      role: 'spec-author',
      worktreePath: '/tmp/wt',
      branch: 'qi/1',
      baseBranch: 'main',
      artifactPath: 'spec.md',
    })
    const snap = await runGraph(node, makeFakeSkillExecutor())
    const results = snap.values.stageResults as Array<{ status: string; error?: string }>
    expect(results[0].status).toBe('failed')
    expect(results[0].error).toContain('SkillNotFoundError')
  })

  it('returns success when runSkill output.decision is undefined (pass)', async () => {
    mockRunSkill.mockResolvedValueOnce(
      makeSkillResult({ output: { summary: 'spec written' } }),
    )
    const node = makeNode('skill_node', {
      requirementId: 1,
      skill: 'test-skill',
      role: 'spec-author',
      worktreePath: '/tmp/wt',
      branch: 'qi/1',
      baseBranch: 'main',
      artifactPath: 'spec.md',
    })
    const snap = await runGraph(node, makeFakeSkillExecutor())
    const results = snap.values.stageResults as Array<{ status: string }>
    expect(results[0].status).toBe('success')
  })

  it('returns success and populates stepOutputs', async () => {
    mockRunSkill.mockResolvedValueOnce(
      makeSkillResult({ output: { summary: 'spec done', decision: undefined } }),
    )
    const node = makeNode('skill_node', {
      requirementId: 1,
      skill: 'test-skill',
      role: 'spec-author',
      worktreePath: '/tmp/wt',
      branch: 'qi/1',
      baseBranch: 'main',
      artifactPath: 'spec.md',
    })
    const snap = await runGraph(node, makeFakeSkillExecutor())
    const stepOutputs = snap.values.stepOutputs as Record<string, { status: string; output: Record<string, unknown> }>
    expect(stepOutputs['n1'].status).toBe('success')
    expect(stepOutputs['n1'].output.summary).toBe('spec done')
  })

  it('returns failed when runSkill output.decision is fail', async () => {
    mockRunSkill.mockResolvedValueOnce(
      makeSkillResult({ output: { summary: 'cannot proceed', decision: 'fail' } }),
    )
    const node = makeNode('skill_node', {
      requirementId: 1,
      skill: 'test-skill',
      role: 'spec-author',
      worktreePath: '/tmp/wt',
      branch: 'qi/1',
      baseBranch: 'main',
      artifactPath: 'spec.md',
    })
    const snap = await runGraph(node, makeFakeSkillExecutor())
    const results = snap.values.stageResults as Array<{ status: string }>
    expect(results[0].status).toBe('failed')
  })

  it('passes requirementId, nodeId, skill, role to runSkill', async () => {
    mockRunSkill.mockResolvedValueOnce(makeSkillResult())
    const node = makeNode('skill_node', {
      requirementId: 42,
      skill: 'my-skill',
      role: 'my-role',
      worktreePath: '/tmp/wt',
      branch: 'qi/42',
      baseBranch: 'develop',
      artifactPath: 'out.md',
      inputs: { spec: 'do X' },
    })
    await runGraph(node, makeFakeSkillExecutor())
    const [opts] = mockRunSkill.mock.calls[0]
    expect(opts.requirementId).toBe(42)
    expect(opts.nodeId).toBe('n1')
    expect(opts.skill).toBe('my-skill')
    expect(opts.role).toBe('my-role')
    expect(opts.inputs).toMatchObject({ spec: 'do X' })
  })
})

// =============================================================================
// skill_with_review
// =============================================================================

describe('skill_with_review', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns failed when skillExecutor is not configured', async () => {
    const node = makeNode('skill_with_review', {
      requirementId: 1,
      devSkill: 'dev-skill',
      devRole: 'dev',
      reviewerSkill: 'rev-skill',
      reviewerRole: 'reviewer',
      worktreePath: '/tmp/wt',
      branch: 'qi/1',
      baseBranch: 'main',
      artifactPath: 'out.md',
    })
    const snap = await runGraph(node, undefined)
    const results = snap.values.stageResults as Array<{ status: string; error?: string }>
    expect(results[0].status).toBe('failed')
    expect(results[0].error).toBe('no_skill_executor')
  })

  it('returns success when reviewer passes on round 1', async () => {
    mockRunSkill
      .mockResolvedValueOnce(makeSkillResult({ output: { summary: 'written' } })) // dev
      .mockResolvedValueOnce(
        makeSkillResult({ output: { summary: 'looks good', decision: 'pass' } }),
      ) // reviewer

    const node = makeNode('skill_with_review', {
      requirementId: 1,
      devSkill: 'dev',
      devRole: 'dev-role',
      reviewerSkill: 'rev',
      reviewerRole: 'rev-role',
      worktreePath: '/tmp/wt',
      branch: 'qi/1',
      baseBranch: 'main',
      artifactPath: 'out.md',
    })
    const snap = await runGraph(node, makeFakeSkillExecutor())
    const results = snap.values.stageResults as Array<{ status: string; output: string }>
    expect(results[0].status).toBe('success')
    expect(results[0].output).toContain('round 1')
  })

  it('passes reviewer notes to dev on round 2', async () => {
    mockRunSkill
      .mockResolvedValueOnce(makeSkillResult({ output: { summary: 'v1' } })) // dev r1
      .mockResolvedValueOnce(
        makeSkillResult({
          output: {
            summary: 'needs fix',
            decision: 'fail',
            notes: [{ severity: 'error', msg: 'missing section A' }],
          },
        }),
      ) // reviewer r1 fail
      .mockResolvedValueOnce(makeSkillResult({ output: { summary: 'v2 fixed' } })) // dev r2
      .mockResolvedValueOnce(
        makeSkillResult({ output: { summary: 'LGTM', decision: 'pass' } }),
      ) // reviewer r2 pass

    const node = makeNode('skill_with_review', {
      requirementId: 1,
      devSkill: 'dev',
      devRole: 'dev-role',
      reviewerSkill: 'rev',
      reviewerRole: 'rev-role',
      worktreePath: '/tmp/wt',
      branch: 'qi/1',
      baseBranch: 'main',
      artifactPath: 'out.md',
      maxRounds: 3,
    })
    const snap = await runGraph(node, makeFakeSkillExecutor())
    const results = snap.values.stageResults as Array<{ status: string; output: string }>
    expect(results[0].status).toBe('success')
    // Dev r2 inputs should contain reviewNotes from r1
    const devR2Call = mockRunSkill.mock.calls[2]
    expect(devR2Call[0].inputs.reviewNotes).toBe('missing section A')
  })

  it('returns failed when dev generator fails', async () => {
    mockRunSkill.mockRejectedValueOnce(new Error('worktree locked'))

    const node = makeNode('skill_with_review', {
      requirementId: 1,
      devSkill: 'dev',
      devRole: 'dev-role',
      reviewerSkill: 'rev',
      reviewerRole: 'rev-role',
      worktreePath: '/tmp/wt',
      branch: 'qi/1',
      baseBranch: 'main',
      artifactPath: 'out.md',
    })
    const snap = await runGraph(node, makeFakeSkillExecutor())
    const results = snap.values.stageResults as Array<{ status: string; error?: string }>
    expect(results[0].status).toBe('failed')
    expect(results[0].error).toContain('worktree locked')
  })

  it('returns failed when dev returns decision=fail', async () => {
    mockRunSkill.mockResolvedValueOnce(
      makeSkillResult({ output: { summary: 'blocked by dep', decision: 'fail' } }),
    )
    const node = makeNode('skill_with_review', {
      requirementId: 1,
      devSkill: 'dev',
      devRole: 'dev-role',
      reviewerSkill: 'rev',
      reviewerRole: 'rev-role',
      worktreePath: '/tmp/wt',
      branch: 'qi/1',
      baseBranch: 'main',
      artifactPath: 'out.md',
    })
    const snap = await runGraph(node, makeFakeSkillExecutor())
    const results = snap.values.stageResults as Array<{ status: string; error?: string }>
    expect(results[0].status).toBe('failed')
    expect(results[0].error).toBe('dev_fail')
  })

  it('returns failed when max rounds exceeded', async () => {
    // dev always passes; reviewer always fails → exhaust maxRounds
    mockRunSkill
      .mockResolvedValueOnce(makeSkillResult({ output: { summary: 'dev r1' } }))
      .mockResolvedValueOnce(makeSkillResult({ output: { summary: 'fail r1', decision: 'fail' } }))
      .mockResolvedValueOnce(makeSkillResult({ output: { summary: 'dev r2' } }))
      .mockResolvedValueOnce(makeSkillResult({ output: { summary: 'fail r2', decision: 'fail' } }))
    const node = makeNode('skill_with_review', {
      requirementId: 1,
      devSkill: 'dev',
      devRole: 'dev-role',
      reviewerSkill: 'rev',
      reviewerRole: 'rev-role',
      worktreePath: '/tmp/wt',
      branch: 'qi/1',
      baseBranch: 'main',
      artifactPath: 'out.md',
      maxRounds: 2,
    })
    const snap = await runGraph(node, makeFakeSkillExecutor())
    const results = snap.values.stageResults as Array<{ status: string; error?: string }>
    expect(results[0].status).toBe('failed')
    expect(results[0].error).toBe('max_rounds_exceeded')
    expect(mockRunSkill).toHaveBeenCalledTimes(4) // 2 rounds × (dev + reviewer)
  })

  it('persists reviewer notes + reviewHistory to stepOutputs on max_rounds_exceeded (PRD #6)', async () => {
    // dev passes, reviewer fails 2 rounds with progressively different notes
    mockRunSkill
      .mockResolvedValueOnce(makeSkillResult({ output: { summary: 'dev r1', tasksDone: [1] } }))
      .mockResolvedValueOnce(
        makeSkillResult({
          output: {
            summary: 'r1 reject',
            decision: 'fail',
            notes: [{ severity: 'error', msg: 'AC-3 not covered' }],
          },
        }),
      )
      .mockResolvedValueOnce(makeSkillResult({ output: { summary: 'dev r2', tasksDone: [1, 2] } }))
      .mockResolvedValueOnce(
        makeSkillResult({
          output: {
            summary: 'r2 still rejecting',
            decision: 'fail',
            notes: [
              { severity: 'error', msg: 'T2 doneWhen too vague' },
              { severity: 'warn', msg: 'estimatedLoc missing' },
            ],
          },
        }),
      )
    const node = makeNode('skill_with_review', {
      requirementId: 1,
      devSkill: 'dev',
      devRole: 'dev-role',
      reviewerSkill: 'rev',
      reviewerRole: 'rev-role',
      worktreePath: '/tmp/wt',
      branch: 'qi/1',
      baseBranch: 'main',
      artifactPath: '/tmp/wt/docs/plans/qi-1.md',
      maxRounds: 2,
    })
    const snap = await runGraph(node, makeFakeSkillExecutor())
    const stepOutputs = snap.values.stepOutputs as Record<
      string,
      { status: string; output: Record<string, unknown> }
    >
    const out = stepOutputs['n1']
    expect(out).toBeDefined()
    expect(out.status).toBe('failed')

    expect(out.output.maxRoundsExceeded).toBe(true)
    expect(out.output.lastArtifactPath).toBe('/tmp/wt/docs/plans/qi-1.md')

    // review = 最后一轮 reviewer 输出（拒绝原因）
    const review = out.output.review as { summary: string; notes: Array<{ msg: string }> }
    expect(review.summary).toBe('r2 still rejecting')
    expect(review.notes).toHaveLength(2)
    expect(review.notes[0].msg).toBe('T2 doneWhen too vague')

    // reviewHistory[] = 全部轮，按 round 排
    const history = out.output.reviewHistory as Array<{ round: number; output: { summary: string } }>
    expect(history).toHaveLength(2)
    expect(history[0].round).toBe(1)
    expect(history[0].output.summary).toBe('r1 reject')
    expect(history[1].round).toBe(2)
    expect(history[1].output.summary).toBe('r2 still rejecting')

    // 最后一轮 dev 的 tasksDone + skillOutput 也持久化
    expect(out.output.tasksDone).toEqual([1, 2])
    expect(out.output.skillOutput).toBeDefined()
  })

  it('populates stepOutputs with review output on success', async () => {
    mockRunSkill
      .mockResolvedValueOnce(makeSkillResult({ output: { summary: 'written' } }))
      .mockResolvedValueOnce(
        makeSkillResult({ output: { summary: 'approved', decision: 'pass' } }),
      )
    const node = makeNode('skill_with_review', {
      requirementId: 1,
      devSkill: 'dev',
      devRole: 'dev-role',
      reviewerSkill: 'rev',
      reviewerRole: 'rev-role',
      worktreePath: '/tmp/wt',
      branch: 'qi/1',
      baseBranch: 'main',
      artifactPath: 'out.md',
    })
    const snap = await runGraph(node, makeFakeSkillExecutor())
    const stepOutputs = snap.values.stepOutputs as Record<string, { status: string; output: Record<string, unknown> }>
    expect(stepOutputs['n1'].status).toBe('success')
    expect(stepOutputs['n1'].output.round).toBe(1)
  })
})

// =============================================================================
// skill_with_approval
// =============================================================================

describe('skill_with_approval', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default: no existing waiter in DB
    mockGetWaiterByNodeAndRound.mockResolvedValue(null)
  })

  it('returns failed when skillExecutor is not configured', async () => {
    const node = makeNode('skill_with_approval', {
      requirementId: 1,
      skill: 'test-skill',
      role: 'dev',
      worktreePath: '/tmp/wt',
      branch: 'qi/1',
      baseBranch: 'main',
      artifactPath: 'out.md',
    })
    const snap = await runGraph(node, undefined)
    const results = snap.values.stageResults as Array<{ status: string; error?: string }>
    expect(results[0].status).toBe('failed')
    expect(results[0].error).toBe('no_skill_executor')
  })

  it('returns failed when generator returns decision=fail', async () => {
    mockRunSkill.mockResolvedValueOnce(
      makeSkillResult({ output: { summary: 'cannot deliver', decision: 'fail' } }),
    )
    const node = makeNode('skill_with_approval', {
      requirementId: 1,
      skill: 'test-skill',
      role: 'dev',
      worktreePath: '/tmp/wt',
      branch: 'qi/1',
      baseBranch: 'main',
      artifactPath: 'out.md',
    })
    const snap = await runGraph(node, makeFakeSkillExecutor())
    const results = snap.values.stageResults as Array<{ status: string; error?: string }>
    expect(results[0].status).toBe('failed')
    expect(results[0].error).toBe('generator_fail')
  })

  it('returns failed when generator throws', async () => {
    mockRunSkill.mockRejectedValueOnce(new Error('skill file missing'))
    const node = makeNode('skill_with_approval', {
      requirementId: 1,
      skill: 'test-skill',
      role: 'dev',
      worktreePath: '/tmp/wt',
      branch: 'qi/1',
      baseBranch: 'main',
      artifactPath: 'out.md',
    })
    const snap = await runGraph(node, makeFakeSkillExecutor())
    const results = snap.values.stageResults as Array<{ status: string; error?: string }>
    expect(results[0].status).toBe('failed')
    expect(results[0].error).toContain('skill file missing')
  })

  it('returns success when interrupt resume decision=approved', async () => {
    mockRunSkill.mockResolvedValueOnce(makeSkillResult())
    mockCreateWaiter.mockResolvedValueOnce(makeWaiterRow({ id: 10 }))
    mockInterrupt.mockReturnValueOnce(makeResume('approved'))

    const node = makeNode('skill_with_approval', {
      requirementId: 1,
      skill: 'test-skill',
      role: 'dev',
      worktreePath: '/tmp/wt',
      branch: 'qi/1',
      baseBranch: 'main',
      artifactPath: 'out.md',
    })
    const snap = await runGraph(node, makeFakeSkillExecutor())
    const results = snap.values.stageResults as Array<{ status: string; output: string }>
    expect(results[0].status).toBe('success')
    expect(results[0].output).toContain('approved')
  })

  it('exposes skillOutput + lastArtifactPath in stepOutputs on approved (downstream template contract)', async () => {
    // 下游 dev_author 用 {{steps.spec_author.output.skillOutput}}
    // 取 spec 的完整对象，{{steps.<id>.output.lastArtifactPath}} 取 spec.md 路径。
    // 没 skillOutput 会让 dev-loop 收到字面量 {{...}}，误判 non-functional change 跳过 playbook。
    const fullSpecOutput = {
      summary: 'spec done',
      decision: 'pass' as const,
      e2eScenarios: [
        { id: 'happy-path', kind: 'happy', name: 'main flow', tags: [], steps: [], coversAC: ['AC-1'], acceptance: [] },
      ],
      acceptanceCriteria: ['AC-1: ...'],
    }
    mockRunSkill.mockResolvedValueOnce(makeSkillResult({
      output: fullSpecOutput,
      rawOutput: '```json\n' + JSON.stringify(fullSpecOutput) + '\n```',
    }))
    mockCreateWaiter.mockResolvedValueOnce(makeWaiterRow({ id: 30 }))
    mockInterrupt.mockReturnValueOnce(makeResume('approved'))

    const node = makeNode('skill_with_approval', {
      requirementId: 1,
      skill: 'test-skill',
      role: 'spec-author',
      worktreePath: '/tmp/wt',
      branch: 'qi/1',
      baseBranch: 'main',
      artifactPath: '/tmp/wt/docs/specs/qi-1.md',
    })
    const snap = await runGraph(node, makeFakeSkillExecutor())
    const stepOutputs = snap.values.stepOutputs as Record<string, { status: string; output: Record<string, unknown> }>
    expect(stepOutputs['n1'].status).toBe('success')
    expect(stepOutputs['n1'].output.lastArtifactPath).toBe('/tmp/wt/docs/specs/qi-1.md')
    expect(stepOutputs['n1'].output.skillOutput).toEqual(fullSpecOutput)
  })

  it('returns success when interrupt resume decision=force_passed', async () => {
    mockRunSkill.mockResolvedValueOnce(makeSkillResult())
    mockCreateWaiter.mockResolvedValueOnce(makeWaiterRow({ id: 11 }))
    mockInterrupt.mockReturnValueOnce(makeResume('force_passed'))

    const node = makeNode('skill_with_approval', {
      requirementId: 1,
      skill: 'test-skill',
      role: 'dev',
      worktreePath: '/tmp/wt',
      branch: 'qi/1',
      baseBranch: 'main',
      artifactPath: 'out.md',
    })
    const snap = await runGraph(node, makeFakeSkillExecutor())
    const results = snap.values.stageResults as Array<{ status: string }>
    expect(results[0].status).toBe('success')
  })

  it('returns failed when interrupt resume decision=aborted', async () => {
    mockRunSkill.mockResolvedValueOnce(makeSkillResult())
    mockCreateWaiter.mockResolvedValueOnce(makeWaiterRow({ id: 12 }))
    mockInterrupt.mockReturnValueOnce(makeResume('aborted'))

    const node = makeNode('skill_with_approval', {
      requirementId: 1,
      skill: 'test-skill',
      role: 'dev',
      worktreePath: '/tmp/wt',
      branch: 'qi/1',
      baseBranch: 'main',
      artifactPath: 'out.md',
    })
    const snap = await runGraph(node, makeFakeSkillExecutor())
    const results = snap.values.stageResults as Array<{ status: string; error?: string }>
    expect(results[0].status).toBe('failed')
    expect(results[0].error).toBe('aborted')
    // requirement status must flip to 'aborted' so the worker reconcile in
    // src/quick-impl/worker.ts:283-288 doesn't overwrite it with 'failed'.
    expect(mockSetRequirementStatus).toHaveBeenCalledWith(1, 'aborted')
  })

  it('loops: rejected r1 → generator runs again r2 → approved', async () => {
    mockRunSkill
      .mockResolvedValueOnce(makeSkillResult({ output: { summary: 'v1' } })) // r1 gen
      .mockResolvedValueOnce(makeSkillResult({ output: { summary: 'v2' } })) // r2 gen
    mockCreateWaiter
      .mockResolvedValueOnce(makeWaiterRow({ id: 20, round: 1 }))
      .mockResolvedValueOnce(makeWaiterRow({ id: 21, round: 2 }))
    mockInterrupt
      .mockReturnValueOnce(
        makeResume('rejected', { rejectReason: 'scope too broad' }),
      ) // r1 → rejected
      .mockReturnValueOnce(makeResume('approved')) // r2 → approved

    const node = makeNode('skill_with_approval', {
      requirementId: 1,
      skill: 'test-skill',
      role: 'dev',
      worktreePath: '/tmp/wt',
      branch: 'qi/1',
      baseBranch: 'main',
      artifactPath: 'out.md',
      maxRounds: 5,
    })
    const snap = await runGraph(node, makeFakeSkillExecutor())
    const results = snap.values.stageResults as Array<{ status: string }>
    expect(results[0].status).toBe('success')
    expect(mockRunSkill).toHaveBeenCalledTimes(2)
    expect(mockInterrupt).toHaveBeenCalledTimes(2)

    // rejectHistory is threaded to r2 generator via inputs
    const r2GenCall = mockRunSkill.mock.calls[1]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r2Inputs = (r2GenCall[0] as any).inputs
    expect(r2Inputs.rejectHistory).toHaveLength(1)
    expect(r2Inputs.rejectHistory[0].reason).toBe('scope too broad')
  })

  it('returns failed when maxRounds exceeded after all rejections', async () => {
    mockRunSkill.mockResolvedValue(makeSkillResult())
    mockCreateWaiter.mockResolvedValue(makeWaiterRow({ id: 30 }))
    mockInterrupt.mockReturnValue(makeResume('rejected', { rejectReason: 'nope' }))

    const node = makeNode('skill_with_approval', {
      requirementId: 1,
      skill: 'test-skill',
      role: 'dev',
      worktreePath: '/tmp/wt',
      branch: 'qi/1',
      baseBranch: 'main',
      artifactPath: 'out.md',
      maxRounds: 2,
    })
    const snap = await runGraph(node, makeFakeSkillExecutor())
    const results = snap.values.stageResults as Array<{ status: string; error?: string }>
    expect(results[0].status).toBe('failed')
    expect(results[0].error).toBe('max_rounds_exceeded')
    expect(mockRunSkill).toHaveBeenCalledTimes(2)
  })

  // PRD #4：skipFirstSkill — round 1 不跑 skill 直接通知人审；round 2+（人拒后）才跑 skill
  it('skipFirstSkill: round 1 approved → 不调用 skill', async () => {
    mockCreateWaiter.mockResolvedValueOnce(makeWaiterRow({ id: 40, approvalKind: 'plan' }))
    mockInterrupt.mockReturnValueOnce(makeResume('approved'))

    const node = makeNode('skill_with_approval', {
      requirementId: 1,
      skill: 'test-skill',
      role: 'plan-decomposer',
      approvalKind: 'plan',
      skipFirstSkill: true,
      worktreePath: '/tmp/wt',
      branch: 'qi/1',
      baseBranch: 'main',
      artifactPath: 'out.md',
    })
    const snap = await runGraph(node, makeFakeSkillExecutor())
    const results = snap.values.stageResults as Array<{ status: string }>
    expect(results[0].status).toBe('success')
    expect(mockRunSkill).not.toHaveBeenCalled()
    expect(mockCreateWaiter).toHaveBeenCalledTimes(1)
  })

  it('skipFirstSkill: round 1 rejected → round 2 跑 skill，人拒 reason 透传', async () => {
    mockRunSkill.mockResolvedValueOnce(makeSkillResult({ output: { summary: 'r2 revision' } }))
    mockCreateWaiter
      .mockResolvedValueOnce(makeWaiterRow({ id: 41, round: 1, approvalKind: 'plan' }))
      .mockResolvedValueOnce(makeWaiterRow({ id: 42, round: 2, approvalKind: 'plan' }))
    mockInterrupt
      .mockReturnValueOnce(makeResume('rejected', { rejectReason: 'T2 拆得太粗' }))
      .mockReturnValueOnce(makeResume('approved'))

    const node = makeNode('skill_with_approval', {
      requirementId: 1,
      skill: 'test-skill',
      role: 'plan-decomposer',
      approvalKind: 'plan',
      skipFirstSkill: true,
      maxRounds: 3,
      worktreePath: '/tmp/wt',
      branch: 'qi/1',
      baseBranch: 'main',
      artifactPath: 'out.md',
    })
    const snap = await runGraph(node, makeFakeSkillExecutor())
    const results = snap.values.stageResults as Array<{ status: string }>
    expect(results[0].status).toBe('success')
    // round 1 不跑 skill，round 2 才跑 → 总共 1 次
    expect(mockRunSkill).toHaveBeenCalledTimes(1)
    expect(mockInterrupt).toHaveBeenCalledTimes(2)

    // round 2 generator 收到人拒 reason
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r2Inputs = (mockRunSkill.mock.calls[0][0] as any).inputs
    expect(r2Inputs.rejectHistory).toHaveLength(1)
    expect(r2Inputs.rejectHistory[0].reason).toBe('T2 拆得太粗')
  })

  it('skipFirstSkill=false (default)：round 1 仍跑 skill', async () => {
    mockRunSkill.mockResolvedValueOnce(makeSkillResult())
    mockCreateWaiter.mockResolvedValueOnce(makeWaiterRow({ id: 43 }))
    mockInterrupt.mockReturnValueOnce(makeResume('approved'))

    const node = makeNode('skill_with_approval', {
      requirementId: 1,
      skill: 'test-skill',
      role: 'dev',
      worktreePath: '/tmp/wt',
      branch: 'qi/1',
      baseBranch: 'main',
      artifactPath: 'out.md',
      // 不传 skipFirstSkill，验证默认行为不变
    })
    const snap = await runGraph(node, makeFakeSkillExecutor())
    const results = snap.values.stageResults as Array<{ status: string }>
    expect(results[0].status).toBe('success')
    expect(mockRunSkill).toHaveBeenCalledTimes(1)
  })

  // PRD §7 step 4 + step 6：plan_escalation decisionSet 4-way 决策路由
  it('decision=rejected_plan → round++ 跑 skill，rejectReason 写入 history', async () => {
    mockRunSkill.mockResolvedValueOnce(makeSkillResult({ output: { summary: 'r2 revision' } }))
    mockCreateWaiter
      .mockResolvedValueOnce(makeWaiterRow({ id: 50, round: 1, decisionSet: 'plan_escalation' }))
      .mockResolvedValueOnce(makeWaiterRow({ id: 51, round: 2, decisionSet: 'plan_escalation' }))
    mockInterrupt
      .mockReturnValueOnce(
        makeResume('rejected_plan', {
          decisionSet: 'plan_escalation',
          rejectReason: 'T2 拆得太粗',
        }),
      )
      .mockReturnValueOnce(makeResume('approved', { decisionSet: 'plan_escalation' }))

    const node = makeNode('skill_with_approval', {
      requirementId: 1,
      skill: 'test-skill',
      role: 'plan-decomposer',
      approvalKind: 'plan',
      decisionSet: 'plan_escalation',
      skipFirstSkill: true,
      maxRounds: 3,
      worktreePath: '/tmp/wt',
      branch: 'qi/1',
      baseBranch: 'main',
      artifactPath: 'out.md',
    })
    const snap = await runGraph(node, makeFakeSkillExecutor())
    const results = snap.values.stageResults as Array<{ status: string }>
    expect(results[0].status).toBe('success')
    // round 1 跳 skill，round 2 跑 1 次
    expect(mockRunSkill).toHaveBeenCalledTimes(1)
    // round 2 generator 收到 rejected_plan 的 reason
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r2Inputs = (mockRunSkill.mock.calls[0][0] as any).inputs
    expect(r2Inputs.rejectHistory[0].reason).toBe('T2 拆得太粗')
  })

  it('decision=rejected_spec → stage failed + error=spec_revision_needed + requirement aborted', async () => {
    mockCreateWaiter.mockResolvedValueOnce(makeWaiterRow({ id: 52, decisionSet: 'plan_escalation' }))
    mockInterrupt.mockReturnValueOnce(
      makeResume('rejected_spec', {
        decisionSet: 'plan_escalation',
        rejectReason: 'spec §3 与 §9 矛盾，无法拆',
      }),
    )

    const node = makeNode('skill_with_approval', {
      requirementId: 1,
      skill: 'test-skill',
      role: 'plan-decomposer',
      approvalKind: 'plan',
      decisionSet: 'plan_escalation',
      skipFirstSkill: true,
      maxRounds: 3,
      worktreePath: '/tmp/wt',
      branch: 'qi/1',
      baseBranch: 'main',
      artifactPath: 'out.md',
    })
    const snap = await runGraph(node, makeFakeSkillExecutor())
    const results = snap.values.stageResults as Array<{ status: string; error?: string; output: string }>
    expect(results[0].status).toBe('failed')
    expect(results[0].error).toBe('spec_revision_needed')
    expect(results[0].output).toContain('[SPEC_REVISION_NEEDED]')
    expect(results[0].output).toContain('spec §3 与 §9 矛盾')
    // requirement → aborted（与现有 abort 行为一致；后续 spec 升级路径 PRD 接管时改）
    expect(mockSetRequirementStatus).toHaveBeenCalledWith(1, 'aborted')
  })

  it('previousRound 含 targetTaskId/citedAiNotes：round 2 generator 拿到字段级反馈（PRD step 6）', async () => {
    mockRunSkill.mockResolvedValueOnce(makeSkillResult({ output: { summary: 'r2 only T2 fixed' } }))
    mockCreateWaiter
      .mockResolvedValueOnce(makeWaiterRow({ id: 60, round: 1, decisionSet: 'plan_escalation' }))
      .mockResolvedValueOnce(makeWaiterRow({ id: 61, round: 2, decisionSet: 'plan_escalation' }))
    mockInterrupt
      .mockReturnValueOnce(
        makeResume('rejected_plan', {
          decisionSet: 'plan_escalation',
          rejectReason: 'T2 doneWhen 太空泛',
          targetTaskId: 'T2',
          citedAiNotes: ['T2 doneWhen[1] 含空洞断言', 'T2.coverAC 缺 AC-3'],
        }),
      )
      .mockReturnValueOnce(makeResume('approved', { decisionSet: 'plan_escalation' }))

    const node = makeNode('skill_with_approval', {
      requirementId: 1,
      skill: 'test-skill',
      role: 'plan-decomposer',
      approvalKind: 'plan',
      decisionSet: 'plan_escalation',
      skipFirstSkill: true,
      maxRounds: 3,
      worktreePath: '/tmp/wt',
      branch: 'qi/1',
      baseBranch: 'main',
      artifactPath: 'out.md',
    })
    const snap = await runGraph(node, makeFakeSkillExecutor())
    const results = snap.values.stageResults as Array<{ status: string }>
    expect(results[0].status).toBe('success')

    // round 2 generator 收到结构化反馈
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r2Call = mockRunSkill.mock.calls[0][0] as any
    expect(r2Call.inputs.rejectHistory[0].targetTaskId).toBe('T2')
    expect(r2Call.inputs.rejectHistory[0].citedAiNotes).toEqual([
      'T2 doneWhen[1] 含空洞断言',
      'T2.coverAC 缺 AC-3',
    ])
    expect(r2Call.previousRound.targetTaskId).toBe('T2')
    expect(r2Call.previousRound.citedAiNotes).toHaveLength(2)
  })

  it('skips generator on replay when waiter already exists', async () => {
    mockGetWaiterByNodeAndRound.mockResolvedValueOnce(
      makeWaiterRow({ id: 40, round: 1 }),
    )
    mockInterrupt.mockReturnValueOnce(makeResume('approved'))

    const node = makeNode('skill_with_approval', {
      requirementId: 1,
      skill: 'test-skill',
      role: 'dev',
      worktreePath: '/tmp/wt',
      branch: 'qi/1',
      baseBranch: 'main',
      artifactPath: 'out.md',
    })
    const snap = await runGraph(node, makeFakeSkillExecutor())
    const results = snap.values.stageResults as Array<{ status: string }>
    expect(results[0].status).toBe('success')
    // Generator was NOT called because waiter already existed
    expect(mockRunSkill).not.toHaveBeenCalled()
    // And createWaiter was also not called
    expect(mockCreateWaiter).not.toHaveBeenCalled()
  })

  it('budget_extended increments budgetUsed and continues loop', async () => {
    mockRunSkill.mockResolvedValue(makeSkillResult())
    mockCreateWaiter.mockResolvedValue(makeWaiterRow({ id: 50 }))
    mockInterrupt
      .mockReturnValueOnce(
        makeResume('budget_extended', { budgetDelta: 2 }),
      ) // extends budget
      .mockReturnValueOnce(makeResume('approved'))

    const node = makeNode('skill_with_approval', {
      requirementId: 1,
      skill: 'test-skill',
      role: 'dev',
      worktreePath: '/tmp/wt',
      branch: 'qi/1',
      baseBranch: 'main',
      artifactPath: 'out.md',
      initialBudget: 0,
      maxRounds: 5,
    })
    const snap = await runGraph(node, makeFakeSkillExecutor())
    const results = snap.values.stageResults as Array<{ status: string }>
    expect(results[0].status).toBe('success')

    // Round 2 generator inputs should see budgetUsed=2
    const r2GenCall = mockRunSkill.mock.calls[1]
    expect(r2GenCall[0].inputs.budgetUsed).toBe(2)
  })
})
