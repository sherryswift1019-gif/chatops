import { describe, it, expect, beforeEach } from 'vitest'
import { resetTestDb, getTestPool } from '../helpers/db.js'

describe('llm_brainstorm node type registration (v1014)', () => {
  beforeEach(async () => { await resetTestDb() })

  it('is present in pipeline_node_types', async () => {
    const pool = getTestPool()
    const { rows } = await pool.query<{ key: string; category: string }>(
      `SELECT key, category FROM pipeline_node_types WHERE key='llm_brainstorm'`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].category).toBe('llm')
  })

  it('output_schema includes brainstorm-specific fields', async () => {
    const pool = getTestPool()
    const { rows } = await pool.query<{ output_schema: any }>(
      `SELECT output_schema FROM pipeline_node_types WHERE key='llm_brainstorm'`,
    )
    const fields = rows[0]?.output_schema?.properties ?? {}
    expect(fields).toHaveProperty('rounds')
    expect(fields).toHaveProperty('readyForSpec')
    expect(fields).toHaveProperty('partial')
    expect(fields).toHaveProperty('enrichedInputPath')
    expect(fields).toHaveProperty('brainstormPath')
  })
})
