import { describe, it, expect, vi } from 'vitest'
import {
  claimApproval,
  shouldEscalate,
  computeNewBudget,
  ApprovalClaimError,
  BUDGET_DELTA_MIN,
  BUDGET_DELTA_MAX,
} from '../../quick-impl/approval-claim.js'
import type {
  ApprovalClaimDeps,
  ClaimApprovalOptions,
} from '../../quick-impl/approval-claim.js'
import type {
  ClaimResult,
  RequirementApprovalWaiter,
} from '../../db/repositories/requirement-approval-waiters.js'

// =============================================================================
// Test fixtures
// =============================================================================

function makeWaiter(
  overrides: Partial<RequirementApprovalWaiter> = {},
): RequirementApprovalWaiter {
  return {
    id: 1,
    requirementId: 10,
    pipelineRunId: 100,
    nodeId: 'spec_review_loop',
    approvalKind: 'spec',
    round: 1,
    decisionSet: 'binary',
    imPlatform: 'dingtalk',
    imGroupId: 'group-1',
    contextSummary: 'Spec draft ready',
    claimedBy: null,
    claimedAt: null,
    decision: null,
    rejectReason: null,
    budgetDelta: null,
    decidedBy: null,
    targetTaskId: null,
    citedAiNotes: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }
}

/**
 * Build a minimal fake ApprovalClaimDeps.
 * `claimWaiter` simulates the DB race: the first call wins (returns claimed=true),
 * subsequent calls return claimed=false with `by` set to the winner.
 */
function makeRaceDeps(
  waiter: RequirementApprovalWaiter,
  opts: {
    /** null means waiter not found */
    returnWaiter?: RequirementApprovalWaiter | null
    /** pre-seed: already claimed by this source (simulates the loser side) */
    alreadyClaimedBy?: 'im' | 'web'
  } = {},
): ApprovalClaimDeps {
  const winner: { source: string | null } = {
    source: opts.alreadyClaimedBy ?? null,
  }
  return {
    getWaiterById: vi.fn(async (_id) =>
      opts.returnWaiter === undefined ? waiter : opts.returnWaiter,
    ),
    claimWaiter: vi.fn(async (_id, source, decision) => {
      if (winner.source === null) {
        // first claimer wins
        winner.source = source
        const claimed: RequirementApprovalWaiter = {
          ...waiter,
          claimedBy: source,
          claimedAt: new Date(),
          decision: decision.decision,
          rejectReason: decision.rejectReason ?? null,
          budgetDelta: decision.budgetDelta ?? null,
          decidedBy: decision.decidedBy ?? null,
        }
        return { claimed: true, waiter: claimed } satisfies ClaimResult
      }
      // already claimed
      return { claimed: false, by: winner.source as 'im' | 'web' } satisfies ClaimResult
    }),
  }
}

// =============================================================================
// 输入校验
// =============================================================================

describe('claimApproval — validation', () => {
  it('throws not_found when waiter does not exist', async () => {
    const deps = makeRaceDeps(makeWaiter(), { returnWaiter: null })
    await expect(
      claimApproval({ waiterId: 1, source: 'web', decision: 'approved' }, deps),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('throws decision_not_allowed for force_passed on binary decision_set', async () => {
    const deps = makeRaceDeps(makeWaiter({ decisionSet: 'binary' }))
    await expect(
      claimApproval(
        { waiterId: 1, source: 'web', decision: 'force_passed' },
        deps,
      ),
    ).rejects.toMatchObject({ code: 'decision_not_allowed' })
  })

  it('throws decision_not_allowed for budget_extended on binary decision_set', async () => {
    const deps = makeRaceDeps(makeWaiter({ decisionSet: 'binary' }))
    await expect(
      claimApproval(
        { waiterId: 1, source: 'web', decision: 'budget_extended', budgetDelta: 2 },
        deps,
      ),
    ).rejects.toMatchObject({ code: 'decision_not_allowed' })
  })

  it('throws decision_not_allowed for aborted on binary decision_set', async () => {
    const deps = makeRaceDeps(makeWaiter({ decisionSet: 'binary' }))
    await expect(
      claimApproval({ waiterId: 1, source: 'web', decision: 'aborted' }, deps),
    ).rejects.toMatchObject({ code: 'decision_not_allowed' })
  })

  it('allows all 5 decisions on escalation decision_set', async () => {
    const decisions = [
      'approved',
      'rejected',
      'force_passed',
      'budget_extended',
      'aborted',
    ] as const
    for (const decision of decisions) {
      const deps = makeRaceDeps(makeWaiter({ decisionSet: 'escalation' }))
      const result = await claimApproval(
        {
          waiterId: 1,
          source: 'web',
          decision,
          budgetDelta: decision === 'budget_extended' ? 2 : undefined,
        },
        deps,
      )
      expect(result.claimed, `decision=${decision} should succeed`).toBe(true)
    }
  })

  // PRD §7 step 4：plan_escalation 接受 4-way（approved / rejected_plan / rejected_spec / aborted）
  it('allows 4 decisions on plan_escalation decision_set', async () => {
    const decisions = ['approved', 'rejected_plan', 'rejected_spec', 'aborted'] as const
    for (const decision of decisions) {
      const deps = makeRaceDeps(makeWaiter({ decisionSet: 'plan_escalation' }))
      const result = await claimApproval(
        { waiterId: 1, source: 'web', decision },
        deps,
      )
      expect(result.claimed, `decision=${decision} should succeed`).toBe(true)
    }
  })

  it('rejects force_passed / budget_extended / rejected on plan_escalation', async () => {
    const forbidden = ['force_passed', 'budget_extended', 'rejected'] as const
    for (const decision of forbidden) {
      const deps = makeRaceDeps(makeWaiter({ decisionSet: 'plan_escalation' }))
      await expect(
        claimApproval({ waiterId: 1, source: 'web', decision }, deps),
      ).rejects.toMatchObject({ code: 'decision_not_allowed' })
    }
  })
})

// =============================================================================
// budget_extended validation
// =============================================================================

describe('claimApproval — budget_extended validation', () => {
  it('throws budget_delta_invalid when budgetDelta is null', async () => {
    const deps = makeRaceDeps(makeWaiter({ decisionSet: 'escalation' }))
    await expect(
      claimApproval(
        { waiterId: 1, source: 'web', decision: 'budget_extended', budgetDelta: null },
        deps,
      ),
    ).rejects.toMatchObject({ code: 'budget_delta_invalid' })
  })

  it('throws budget_delta_invalid when budgetDelta is 0', async () => {
    const deps = makeRaceDeps(makeWaiter({ decisionSet: 'escalation' }))
    await expect(
      claimApproval(
        { waiterId: 1, source: 'web', decision: 'budget_extended', budgetDelta: 0 },
        deps,
      ),
    ).rejects.toMatchObject({ code: 'budget_delta_invalid' })
  })

  it(`throws budget_delta_invalid when budgetDelta > ${BUDGET_DELTA_MAX}`, async () => {
    const deps = makeRaceDeps(makeWaiter({ decisionSet: 'escalation' }))
    await expect(
      claimApproval(
        {
          waiterId: 1,
          source: 'web',
          decision: 'budget_extended',
          budgetDelta: BUDGET_DELTA_MAX + 1,
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: 'budget_delta_invalid' })
  })

  it(`throws budget_delta_invalid when budgetDelta is non-integer`, async () => {
    const deps = makeRaceDeps(makeWaiter({ decisionSet: 'escalation' }))
    await expect(
      claimApproval(
        { waiterId: 1, source: 'web', decision: 'budget_extended', budgetDelta: 1.5 },
        deps,
      ),
    ).rejects.toMatchObject({ code: 'budget_delta_invalid' })
  })

  it(`accepts budgetDelta at boundary values ${BUDGET_DELTA_MIN} and ${BUDGET_DELTA_MAX}`, async () => {
    for (const delta of [BUDGET_DELTA_MIN, BUDGET_DELTA_MAX]) {
      const deps = makeRaceDeps(makeWaiter({ decisionSet: 'escalation' }))
      const result = await claimApproval(
        {
          waiterId: 1,
          source: 'web',
          decision: 'budget_extended',
          budgetDelta: delta,
        },
        deps,
      )
      expect(result.claimed, `delta=${delta}`).toBe(true)
    }
  })
})

// =============================================================================
// Race-winner claim：IM 先 / Web 先
// =============================================================================

describe('claimApproval — dual-channel race', () => {
  it('IM wins when IM arrives first (approved)', async () => {
    const deps = makeRaceDeps(makeWaiter())
    const result = await claimApproval(
      { waiterId: 1, source: 'im', decision: 'approved' },
      deps,
    )
    expect(result.claimed).toBe(true)
    expect(result.waiter?.claimedBy).toBe('im')
    expect(result.waiter?.decision).toBe('approved')
    expect(deps.claimWaiter).toHaveBeenCalledOnce()
  })

  it('Web wins when Web arrives first (rejected)', async () => {
    const deps = makeRaceDeps(makeWaiter())
    const result = await claimApproval(
      {
        waiterId: 1,
        source: 'web',
        decision: 'rejected',
        rejectReason: 'spec is incomplete',
        decidedBy: 'alice',
      },
      deps,
    )
    expect(result.claimed).toBe(true)
    expect(result.waiter?.claimedBy).toBe('web')
    expect(result.waiter?.decision).toBe('rejected')
    expect(result.waiter?.rejectReason).toBe('spec is incomplete')
    expect(result.waiter?.decidedBy).toBe('alice')
  })

  it('Web arrives second → claimed=false, by=im', async () => {
    const deps = makeRaceDeps(makeWaiter(), { alreadyClaimedBy: 'im' })
    const result = await claimApproval(
      { waiterId: 1, source: 'web', decision: 'approved' },
      deps,
    )
    expect(result.claimed).toBe(false)
    expect(result.by).toBe('im')
  })

  it('IM arrives second → claimed=false, by=web', async () => {
    const deps = makeRaceDeps(makeWaiter(), { alreadyClaimedBy: 'web' })
    const result = await claimApproval(
      { waiterId: 1, source: 'im', decision: 'approved' },
      deps,
    )
    expect(result.claimed).toBe(false)
    expect(result.by).toBe('web')
  })

  it('concurrent race: only one of two simultaneous claimers wins', async () => {
    // Simulate true concurrency with a shared winner state
    const winner: { source: string | null } = { source: null }
    const waiter = makeWaiter()
    const concurrentDeps: ApprovalClaimDeps = {
      getWaiterById: vi.fn(async () => waiter),
      claimWaiter: vi.fn(async (_id, source) => {
        if (winner.source === null) {
          winner.source = source
          return { claimed: true, waiter: { ...waiter, claimedBy: source, decision: 'approved' as const, claimedAt: new Date(), rejectReason: null, budgetDelta: null, decidedBy: null } }
        }
        return { claimed: false, by: winner.source as 'im' | 'web' }
      }),
    }

    const [imResult, webResult] = await Promise.all([
      claimApproval({ waiterId: 1, source: 'im', decision: 'approved' }, concurrentDeps),
      claimApproval({ waiterId: 1, source: 'web', decision: 'approved' }, concurrentDeps),
    ])

    const results = [imResult, webResult]
    const claimedCount = results.filter((r) => r.claimed).length
    const rejectedCount = results.filter((r) => !r.claimed).length
    expect(claimedCount).toBe(1)
    expect(rejectedCount).toBe(1)
  })
})

// =============================================================================
// reject reason 注入
// =============================================================================

describe('claimApproval — reject reason injection', () => {
  it('reject reason is passed through to claimWaiter', async () => {
    const deps = makeRaceDeps(makeWaiter())
    const reason = 'Missing acceptance criteria'
    await claimApproval(
      { waiterId: 1, source: 'web', decision: 'rejected', rejectReason: reason },
      deps,
    )
    expect(deps.claimWaiter).toHaveBeenCalledWith(
      1,
      'web',
      expect.objectContaining({ rejectReason: reason }),
    )
  })

  it('reject reason defaults to null when not provided', async () => {
    const deps = makeRaceDeps(makeWaiter())
    await claimApproval({ waiterId: 1, source: 'web', decision: 'rejected' }, deps)
    expect(deps.claimWaiter).toHaveBeenCalledWith(
      1,
      'web',
      expect.objectContaining({ rejectReason: null }),
    )
  })

  it('budget_extended: budgetDelta is passed through to claimWaiter', async () => {
    const deps = makeRaceDeps(makeWaiter({ decisionSet: 'escalation' }))
    await claimApproval(
      { waiterId: 1, source: 'web', decision: 'budget_extended', budgetDelta: 3 },
      deps,
    )
    expect(deps.claimWaiter).toHaveBeenCalledWith(
      1,
      'web',
      expect.objectContaining({ budgetDelta: 3, decision: 'budget_extended' }),
    )
  })
})

// =============================================================================
// shouldEscalate — budget 上限判断
// =============================================================================

describe('shouldEscalate', () => {
  it('returns false when round < budget', () => {
    expect(shouldEscalate(1, 5)).toBe(false)
    expect(shouldEscalate(4, 5)).toBe(false)
  })

  it('returns true when round === budget (limit reached)', () => {
    expect(shouldEscalate(5, 5)).toBe(true)
  })

  it('returns true when round > budget (already over)', () => {
    expect(shouldEscalate(6, 5)).toBe(true)
  })

  it('budget=1 escalates immediately on first rejection (round=1)', () => {
    expect(shouldEscalate(1, 1)).toBe(true)
  })

  it('budget=1 does not escalate at round=0 (pre-loop)', () => {
    expect(shouldEscalate(0, 1)).toBe(false)
  })
})

// =============================================================================
// computeNewBudget
// =============================================================================

describe('computeNewBudget', () => {
  it('adds delta to current budget', () => {
    expect(computeNewBudget(5, 2)).toBe(7)
    expect(computeNewBudget(3, BUDGET_DELTA_MAX)).toBe(3 + BUDGET_DELTA_MAX)
  })

  it('adding minimum delta extends by 1', () => {
    expect(computeNewBudget(5, BUDGET_DELTA_MIN)).toBe(6)
  })
})
