import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { resetTestDb } from '../helpers/db.js'
import { createRequirement } from '../../db/repositories/requirements.js'
import {
  createWaiter,
  getActiveWaiter,
  getWaiterById,
  invalidateWaiter,
} from '../../db/repositories/requirement-approval-waiters.js'

describe('invalidateWaiter', () => {
  let reqId: number

  beforeAll(async () => { await resetTestDb() })

  beforeEach(async () => {
    const r = await createRequirement({
      title: 't', rawInput: 'r', gitlabProject: 'g/p', source: 'web', status: 'draft',
    })
    reqId = r.id
  })

  it('invalidates active waiter: claimed_by="system" + decision="aborted" + getActiveWaiter no longer returns it', async () => {
    const w = await createWaiter({
      requirementId: reqId,
      pipelineRunId: 1,
      nodeId: 'spec_human_gate',
      approvalKind: 'spec',
      round: 1,
      decisionSet: 'human_gate',
      contextSummary: 'test',
    })
    expect(await getActiveWaiter(reqId, 'spec_human_gate')).not.toBeNull()

    const ok = await invalidateWaiter(w.id)
    expect(ok).toBe(true)

    const after = await getWaiterById(w.id)
    expect(after?.claimedBy).toBe('system')
    expect(after?.decision).toBe('aborted')
    expect(after?.claimedAt).not.toBeNull()

    expect(await getActiveWaiter(reqId, 'spec_human_gate')).toBeNull()
  })

  it('returns false if waiter already claimed (no double-invalidate)', async () => {
    const w = await createWaiter({
      requirementId: reqId,
      pipelineRunId: 1,
      nodeId: 'spec_human_gate',
      approvalKind: 'spec',
      round: 1,
      decisionSet: 'human_gate',
      contextSummary: 'test',
    })
    // Mark as claimed (simulating user already decided)
    await invalidateWaiter(w.id)  // first call: returns true
    const second = await invalidateWaiter(w.id)
    expect(second).toBe(false)  // second call: noop because not active
  })

  it('returns false if waiter id does not exist', async () => {
    const result = await invalidateWaiter(999999)
    expect(result).toBe(false)
  })
})
