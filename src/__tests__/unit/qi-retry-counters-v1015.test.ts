import { describe, it, expect, beforeEach } from 'vitest'
import { resetTestDb, getTestPool } from '../helpers/db.js'

describe('schema-v1015 retry_counters JSONB documentation', () => {
  beforeEach(async () => { await resetTestDb() })

  it('stores ai_review_rounds and last_ai_review_notes in retry_counters JSONB', async () => {
    const pool = getTestPool()
    await pool.query(
      `INSERT INTO requirements (id, title, raw_input, status, gitlab_project, retry_counters)
       VALUES (1, 'test req', 'test', 'draft', 'test/project', $1)`,
      [JSON.stringify({
        reject_counts: { spec_human_gate: 0 },
        ai_review_rounds: { spec_ai_review: 2 },
        last_ai_review_notes: { spec_author: [{ severity: 'error', msg: 'AC-3 主观词' }] },
      })],
    )
    const { rows } = await pool.query<{ retry_counters: any }>(
      `SELECT retry_counters FROM requirements WHERE id=1`,
    )
    expect(rows[0].retry_counters.ai_review_rounds.spec_ai_review).toBe(2)
    expect(rows[0].retry_counters.last_ai_review_notes.spec_author[0].msg).toBe('AC-3 主观词')
  })

  it('column COMMENT documents the JSONB schema shape', async () => {
    const pool = getTestPool()
    const { rows } = await pool.query<{ comment: string | null }>(
      `SELECT col_description(
         (SELECT oid FROM pg_class WHERE relname='requirements'),
         (SELECT attnum FROM pg_attribute WHERE attrelid=(SELECT oid FROM pg_class WHERE relname='requirements') AND attname='retry_counters')
       ) AS comment`,
    )
    expect(rows[0].comment).toContain('ai_review_rounds')
    expect(rows[0].comment).toContain('last_ai_review_notes')
  })
})
