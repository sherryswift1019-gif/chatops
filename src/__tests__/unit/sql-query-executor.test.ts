import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { ExecutionContext } from '../../pipeline/node-types/types.js'
import '../../pipeline/node-types/sql-query.js'
import { getExecutor } from '../../pipeline/node-types/registry.js'
import { getPool } from '../../db/client.js'

const TABLE = `t_sql_query_${Math.random().toString(36).slice(2, 10)}`

function makeCtx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    runId: 1,
    pipelineId: 100,
    nodeId: 'q1',
    triggerParams: {},
    vars: {},
    steps: {},
    ...overrides,
  }
}

function loadSqlQueryExecutor() {
  const exec = getExecutor('sql_query')
  if (!exec) throw new Error('sql_query executor not registered')
  return exec
}

describe('sql_query node executor (phase 3 T12)', () => {
  beforeAll(async () => {
    await getPool().query(
      `CREATE TABLE ${TABLE} (id INT PRIMARY KEY, name TEXT, val INT)`,
    )
    await getPool().query(
      `INSERT INTO ${TABLE} (id, name, val) VALUES (1,'a',10),(2,'b',20),(3,'c',30)`,
    )
  })

  afterAll(async () => {
    await getPool().query(`DROP TABLE IF EXISTS ${TABLE}`)
  })

  it('SELECT all returns full rows array', async () => {
    const exec = loadSqlQueryExecutor()
    const result = await exec.execute(
      { sqlTemplate: `SELECT id, name, val FROM ${TABLE} ORDER BY id` },
      makeCtx(),
    )
    expect(result.status).toBe('success')
    const rows = (result.output as Record<string, unknown>).rows as Array<Record<string, unknown>>
    expect(rows).toEqual([
      { id: 1, name: 'a', val: 10 },
      { id: 2, name: 'b', val: 20 },
      { id: 3, name: 'c', val: 30 },
    ])
  })

  it('SELECT WHERE with $1 param returns filtered rows', async () => {
    const exec = loadSqlQueryExecutor()
    const result = await exec.execute(
      { sqlTemplate: `SELECT id, name FROM ${TABLE} WHERE val >= $1 ORDER BY id`, params: [20] },
      makeCtx(),
    )
    expect(result.status).toBe('success')
    const rows = (result.output as Record<string, unknown>).rows as Array<Record<string, unknown>>
    expect(rows).toHaveLength(2)
    expect(rows.map(r => r.id)).toEqual([2, 3])
  })

  it('SELECT no match returns empty rows array (still success)', async () => {
    const exec = loadSqlQueryExecutor()
    const result = await exec.execute(
      { sqlTemplate: `SELECT id FROM ${TABLE} WHERE id = $1`, params: [9999] },
      makeCtx(),
    )
    expect(result.status).toBe('success')
    expect((result.output as Record<string, unknown>).rows).toEqual([])
  })

  it('returns failed when sqlTemplate missing', async () => {
    const exec = loadSqlQueryExecutor()
    const result = await exec.execute({}, makeCtx())
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/sqlTemplate/)
  })

  it('returns failed when SQL targets unknown table', async () => {
    const exec = loadSqlQueryExecutor()
    const result = await exec.execute(
      { sqlTemplate: `SELECT * FROM not_a_real_table_xyz` },
      makeCtx(),
    )
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/relation/)
  })
})
