import { describe, it, expect, beforeEach } from 'vitest'
import { resetTestDb, getTestPool } from '../helpers/db.js'
import { loadQiConfig } from '../../quick-impl/qi-config.js'

describe('loadQiConfig', () => {
  beforeEach(async () => { await resetTestDb() })

  it('returns defaults when no system_config row exists', async () => {
    const cfg = await loadQiConfig()
    expect(cfg.aiReviewMaxRounds).toBe(3)
    expect(cfg.tokenBudgetPerRequirement).toBe(250000)
  })

  it('returns DB values when set', async () => {
    const pool = getTestPool()
    await pool.query(
      `INSERT INTO system_config(key, value) VALUES ('qi', $1)
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
      [JSON.stringify({ aiReviewMaxRounds: 2, tokenBudgetPerRequirement: 100000 })],
    )
    const cfg = await loadQiConfig()
    expect(cfg.aiReviewMaxRounds).toBe(2)
    expect(cfg.tokenBudgetPerRequirement).toBe(100000)
  })

  it('clamps aiReviewMaxRounds to [1,5]', async () => {
    const pool = getTestPool()
    await pool.query(
      `INSERT INTO system_config(key, value) VALUES ('qi', $1)
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
      [JSON.stringify({ aiReviewMaxRounds: 99 })],
    )
    const cfg = await loadQiConfig()
    expect(cfg.aiReviewMaxRounds).toBe(5)
  })

  it('clamps aiReviewMaxRounds below 1 back to 1', async () => {
    const pool = getTestPool()
    await pool.query(
      `INSERT INTO system_config(key, value) VALUES ('qi', $1)
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
      [JSON.stringify({ aiReviewMaxRounds: 0 })],
    )
    const cfg = await loadQiConfig()
    expect(cfg.aiReviewMaxRounds).toBe(1)
  })
})
