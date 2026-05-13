import { describe, it, expect, beforeEach } from 'vitest'
import { resetTestDb, getTestPool } from '../helpers/db.js'
import { checkTokenBudget, getCumulativeTokenUsage } from '../../quick-impl/qi-config.js'

describe('checkTokenBudget', () => {
  it('returns ok=true when under budget', () => {
    const r = checkTokenBudget({ usedTokens: 100000, budget: 250000 })
    expect(r.ok).toBe(true)
    expect(r.usedTokens).toBe(100000)
    expect(r.budget).toBe(250000)
  })

  it('returns ok=false when over budget', () => {
    const r = checkTokenBudget({ usedTokens: 300000, budget: 250000 })
    expect(r.ok).toBe(false)
  })

  it('returns ok=false when at exact budget (strict <)', () => {
    const r = checkTokenBudget({ usedTokens: 250000, budget: 250000 })
    expect(r.ok).toBe(false)
  })
})

describe('getCumulativeTokenUsage', () => {
  beforeEach(async () => { await resetTestDb() })

  it('returns 0 when no run state rows', async () => {
    const t = await getCumulativeTokenUsage(999)
    expect(t).toBe(0)
  })

  it('sums data.token_total from pipeline_run_state rows for the run', async () => {
    const pool = getTestPool()
    // pipeline_run_state.pipeline_run_id is INT with no FK — no need to seed test_runs
    await pool.query(`
      INSERT INTO pipeline_run_state(pipeline_run_id, data)
      VALUES (1, '{"token_total": 30000}'::jsonb), (1, '{"token_total": 50000}'::jsonb)`)
    const t = await getCumulativeTokenUsage(1)
    expect(t).toBe(80000)
  })
})
