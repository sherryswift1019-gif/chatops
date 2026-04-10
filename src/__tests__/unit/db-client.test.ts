import { describe, it, expect } from 'vitest'
import { getPool } from '../../db/client.js'

describe('db client', () => {
  it('returns the same pool instance on repeated calls', () => {
    const a = getPool()
    const b = getPool()
    expect(a).toBe(b)
  })

  it('can execute a query', async () => {
    const pool = getPool()
    const { rows } = await pool.query('SELECT 1 AS n')
    expect(rows[0].n).toBe(1)
  })
})
