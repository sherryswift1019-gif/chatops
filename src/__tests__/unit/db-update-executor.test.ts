import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { ExecutionContext } from '../../pipeline/node-types/types.js'
import '../../pipeline/node-types/db-update.js'
import { getExecutor } from '../../pipeline/node-types/registry.js'
import { getPool } from '../../db/client.js'

const TABLE = `t_db_update_${Math.random().toString(36).slice(2, 10)}`

function makeCtx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    runId: 1,
    pipelineId: 100,
    nodeId: 'u1',
    triggerParams: {},
    vars: {},
    steps: {},
    ...overrides,
  }
}

function loadDbUpdateExecutor() {
  const exec = getExecutor('db_update')
  if (!exec) throw new Error('db_update executor not registered')
  return exec
}

describe('db_update node executor (phase 3 T11)', () => {
  beforeAll(async () => {
    await getPool().query(
      `CREATE TABLE ${TABLE} (id INT PRIMARY KEY, name TEXT, val INT DEFAULT 0)`,
    )
  })

  afterAll(async () => {
    await getPool().query(`DROP TABLE IF EXISTS ${TABLE}`)
  })

  it('INSERT returns rowsAffected=1', async () => {
    const exec = loadDbUpdateExecutor()
    const result = await exec.execute(
      { sqlTemplate: `INSERT INTO ${TABLE} (id, name) VALUES ($1, $2)`, params: [1, 'a'] },
      makeCtx(),
    )
    expect(result.status).toBe('success')
    expect((result.output as Record<string, unknown>).rowsAffected).toBe(1)
  })

  it('UPDATE returns affected row count', async () => {
    await getPool().query(`INSERT INTO ${TABLE} (id, name) VALUES (10, 'x'), (11, 'y'), (12, 'y')`)
    const exec = loadDbUpdateExecutor()
    const result = await exec.execute(
      { sqlTemplate: `UPDATE ${TABLE} SET val=$1 WHERE name=$2`, params: [42, 'y'] },
      makeCtx(),
    )
    expect(result.status).toBe('success')
    expect((result.output as Record<string, unknown>).rowsAffected).toBe(2)
  })

  it('DELETE returns rowsAffected=0 if no match', async () => {
    const exec = loadDbUpdateExecutor()
    const result = await exec.execute(
      { sqlTemplate: `DELETE FROM ${TABLE} WHERE id=$1`, params: [99999] },
      makeCtx(),
    )
    expect(result.status).toBe('success')
    expect((result.output as Record<string, unknown>).rowsAffected).toBe(0)
  })

  it('returns failed when sqlTemplate missing', async () => {
    const exec = loadDbUpdateExecutor()
    const result = await exec.execute({}, makeCtx())
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/sqlTemplate/)
  })

  it('returns failed when sqlTemplate is blank', async () => {
    const exec = loadDbUpdateExecutor()
    const result = await exec.execute({ sqlTemplate: '   ' }, makeCtx())
    expect(result.status).toBe('failed')
  })

  it('returns failed when SQL is syntactically invalid', async () => {
    const exec = loadDbUpdateExecutor()
    const result = await exec.execute(
      { sqlTemplate: 'INSERT INTO not_a_real_table_xyz (col) VALUES ($1)', params: [1] },
      makeCtx(),
    )
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/relation/)
  })

  it('handles params=undefined (treats as [])', async () => {
    const exec = loadDbUpdateExecutor()
    const result = await exec.execute(
      { sqlTemplate: `UPDATE ${TABLE} SET val = val + 1 WHERE id IS NULL` },
      makeCtx(),
    )
    expect(result.status).toBe('success')
    expect((result.output as Record<string, unknown>).rowsAffected).toBe(0)
  })
})
