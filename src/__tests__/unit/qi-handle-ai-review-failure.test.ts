import { describe, it, expect, beforeEach, vi } from 'vitest'
import { resetTestDb, getTestPool } from '../helpers/db.js'
import { handleAiReviewFailure } from '../../pipeline/graph-builder.js'
import { createRequirement } from '../../db/repositories/requirements.js'

// retryFromNode 是 fire-and-forget setTimeout(100ms)，需要 spy；不真触发 graph runner
vi.mock('../../pipeline/graph-runner.js', () => ({
  retryFromNode: vi.fn().mockResolvedValue(undefined),
}))

describe('handleAiReviewFailure', () => {
  beforeEach(async () => { await resetTestDb() })

  it('increments ai_review_rounds and triggers retry within cap', async () => {
    const req = await createRequirement({
      title: 'x', rawInput: 'x', gitlabProject: 'g/p', source: 'web', status: 'spec_review',
    })
    const r = await handleAiReviewFailure({
      runId: 1, requirementId: req.id, reviewNodeId: 'spec_ai_review',
      retryToOnFailure: 'spec_author', reviewNotes: [{ severity: 'error', msg: 'AC-3 主观' }],
      aiReviewMaxRounds: 3,
    })
    expect(r.shouldRetry).toBe(true)
    expect(r.newCount).toBe(1)

    const pool = getTestPool()
    const { rows } = await pool.query(
      `SELECT retry_counters FROM requirements WHERE id=$1`, [req.id])
    expect(rows[0].retry_counters.ai_review_rounds.spec_ai_review).toBe(1)
    expect(rows[0].retry_counters.last_ai_review_notes.spec_author).toHaveLength(1)
    expect(rows[0].retry_counters.last_ai_review_notes.spec_author[0].msg).toBe('AC-3 主观')
  })

  it('does not retry once cap is reached', async () => {
    const req = await createRequirement({
      title: 'x', rawInput: 'x', gitlabProject: 'g/p', source: 'web', status: 'spec_review',
    })
    const pool = getTestPool()
    await pool.query(
      `UPDATE requirements SET retry_counters = $1::jsonb WHERE id = $2`,
      [JSON.stringify({ ai_review_rounds: { spec_ai_review: 3 } }), req.id],
    )
    const r = await handleAiReviewFailure({
      runId: 1, requirementId: req.id, reviewNodeId: 'spec_ai_review',
      retryToOnFailure: 'spec_author', reviewNotes: [],
      aiReviewMaxRounds: 3,
    })
    expect(r.shouldRetry).toBe(false)
    expect(r.newCount).toBe(3)
  })

  it('counters do not interfere: incrementing ai_review_rounds does not change reject_counts', async () => {
    const req = await createRequirement({
      title: 'x', rawInput: 'x', gitlabProject: 'g/p', source: 'web', status: 'spec_review',
    })
    const pool = getTestPool()
    // seed both counters
    await pool.query(
      `UPDATE requirements SET retry_counters = $1::jsonb WHERE id = $2`,
      [JSON.stringify({
        reject_counts: { spec_human_gate: 1 },
        ai_review_rounds: { spec_ai_review: 1 },
      }), req.id],
    )
    await handleAiReviewFailure({
      runId: 1, requirementId: req.id, reviewNodeId: 'spec_ai_review',
      retryToOnFailure: 'spec_author', reviewNotes: [],
      aiReviewMaxRounds: 3,
    })
    const { rows } = await pool.query(
      `SELECT retry_counters FROM requirements WHERE id=$1`, [req.id])
    expect(rows[0].retry_counters.reject_counts.spec_human_gate).toBe(1) // unchanged
    expect(rows[0].retry_counters.ai_review_rounds.spec_ai_review).toBe(2) // incremented
  })
})
