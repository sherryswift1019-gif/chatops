import { describe, it, expect, beforeEach } from 'vitest'
import { resetTestDb } from '../helpers/db.js'
import {
  createBrainstormWaiter,
  getBrainstormWaiterById,
  getBrainstormWaiterByRound,
  listBrainstormWaitersForRun,
  listBrainstormWaitersForRequirement,
  getActiveBrainstormWaiterForRequirement,
  answerBrainstormWaiter,
  markBrainstormExpired,
  reapExpiredBrainstormWaiters,
  deleteBrainstormWaitersForRequirement,
} from '../../db/repositories/brainstorm-waiters.js'

const baseInput = (over: Partial<Parameters<typeof createBrainstormWaiter>[0]> = {}) => ({
  requirementId: 100,
  pipelineRunId: 1000,
  threadId: '1000',
  nodeId: 'spec_brainstorm',
  round: 1,
  questionMd: '## 已查证的现状\nx\n## 这一轮要决定\ny\n## 选项（带我的推荐）\n**A.** opt1\n**B.** opt2\n## 我替你做的默认\nA\n## 你怎么回？\nA',
  options: [{ id: 'A', label: 'opt1' }, { id: 'B', label: 'opt2' }],
  enrichedInput: {},
  history: [],
  failedQualityRounds: 0,
  readyForSpec: false,
  expiresAt: new Date(Date.now() + 86400000).toISOString(),
  ...over,
})

describe('brainstorm-waiters repo', () => {
  beforeEach(async () => { await resetTestDb() })

  it('create + getById round-trips field types', async () => {
    const w = await createBrainstormWaiter(baseInput())
    expect(w.id).toBeGreaterThan(0)
    expect(w.status).toBe('pending')
    expect(w.options).toHaveLength(2)
    expect(w.options[0]).toEqual({ id: 'A', label: 'opt1' })

    const re = await getBrainstormWaiterById(w.id)
    expect(re?.id).toBe(w.id)
    expect(re?.questionMd).toBe(w.questionMd)
  })

  it('UNIQUE (pipeline_run_id, node_id, round) prevents duplicate rows', async () => {
    await createBrainstormWaiter(baseInput({ round: 1 }))
    await expect(
      createBrainstormWaiter(baseInput({ round: 1 })),
    ).rejects.toThrow(/duplicate key|unique/i)
  })

  it('getByRound retrieves the right row', async () => {
    await createBrainstormWaiter(baseInput({ round: 1 }))
    await createBrainstormWaiter(baseInput({ round: 2 }))
    const r2 = await getBrainstormWaiterByRound(1000, 'spec_brainstorm', 2)
    expect(r2?.round).toBe(2)
  })

  it('listForRun returns ascending by round', async () => {
    await createBrainstormWaiter(baseInput({ round: 2 }))
    await createBrainstormWaiter(baseInput({ round: 1 }))
    const rows = await listBrainstormWaitersForRun(1000, 'spec_brainstorm')
    expect(rows.map(r => r.round)).toEqual([1, 2])
  })

  it('listForRequirement scopes by requirement_id', async () => {
    await createBrainstormWaiter(baseInput({ requirementId: 100, pipelineRunId: 1000, round: 1 }))
    await createBrainstormWaiter(baseInput({ requirementId: 100, pipelineRunId: 1001, round: 1 }))
    await createBrainstormWaiter(baseInput({ requirementId: 200, pipelineRunId: 2000, round: 1 }))
    const r100 = await listBrainstormWaitersForRequirement(100)
    expect(r100).toHaveLength(2)
    const r200 = await listBrainstormWaitersForRequirement(200)
    expect(r200).toHaveLength(1)
  })

  it('answerBrainstormWaiter race-claim: 1st wins, 2nd returns null', async () => {
    const w = await createBrainstormWaiter(baseInput())
    const r1 = await answerBrainstormWaiter(w.id, w.requirementId, { source: 'web', chosenOption: 'A' })
    expect(r1?.status).toBe('answered')
    expect(r1?.chosenOption).toBe('A')

    const r2 = await answerBrainstormWaiter(w.id, w.requirementId, { source: 'web', chosenOption: 'B' })
    expect(r2).toBeNull()
  })

  it('answerBrainstormWaiter rejects wrong requirement_id (IDOR guard)', async () => {
    const w = await createBrainstormWaiter(baseInput({ requirementId: 100 }))
    const r = await answerBrainstormWaiter(w.id, 999, { source: 'web', chosenOption: 'A' })
    expect(r).toBeNull()
  })

  it('getActiveBrainstormWaiterForRequirement: only pending, latest round', async () => {
    const w1 = await createBrainstormWaiter(baseInput({ round: 1 }))
    await answerBrainstormWaiter(w1.id, w1.requirementId, { source: 'web', chosenOption: 'A' })
    await createBrainstormWaiter(baseInput({ round: 2 }))
    const active = await getActiveBrainstormWaiterForRequirement(100)
    expect(active?.round).toBe(2)
    expect(active?.status).toBe('pending')
  })

  it('markBrainstormExpired: only flips pending → expired (idempotent)', async () => {
    const w = await createBrainstormWaiter(baseInput())
    const r1 = await markBrainstormExpired(w.id)
    expect(r1?.status).toBe('expired')
    const r2 = await markBrainstormExpired(w.id)
    expect(r2).toBeNull()
  })

  it('reapExpired: only old pending rows get expired', async () => {
    const future = new Date(Date.now() + 86400000).toISOString()
    const past = new Date(Date.now() - 60000).toISOString()
    const live = await createBrainstormWaiter(baseInput({ round: 1, expiresAt: future }))
    const dead = await createBrainstormWaiter(baseInput({ round: 2, expiresAt: past }))
    const reaped = await reapExpiredBrainstormWaiters()
    expect(reaped.map(r => r.id)).toEqual([dead.id])
    const liveAfter = await getBrainstormWaiterById(live.id)
    expect(liveAfter?.status).toBe('pending')
    const deadAfter = await getBrainstormWaiterById(dead.id)
    expect(deadAfter?.status).toBe('expired')
  })

  it('deleteForRequirement cascades all rows', async () => {
    await createBrainstormWaiter(baseInput({ round: 1 }))
    await createBrainstormWaiter(baseInput({ round: 2 }))
    const n = await deleteBrainstormWaitersForRequirement(100)
    expect(n).toBe(2)
    const after = await listBrainstormWaitersForRequirement(100)
    expect(after).toHaveLength(0)
  })
})
