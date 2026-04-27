import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { resetTestDb, getTestPool } from '../helpers/db.js'

describe('v44 migration', () => {
  beforeEach(async () => {
    await resetTestDb()
  })

  it('节点类型注册：pipeline_node_types 表加入 switch 行', async () => {
    const sql = readFileSync(join(process.cwd(), 'src/db/schema-v44.sql'), 'utf8')
    await getTestPool().query(sql)
    const r = await getTestPool().query("SELECT key FROM pipeline_node_types WHERE key='switch'")
    expect(r.rowCount).toBe(1)
  })

  it("llm_agent 节点显式补 outputFormat='string'", async () => {
    const pool = getTestPool()
    // 插入 fixture pipeline，含 llm_agent 节点（无 outputFormat）
    await pool.query(
      `INSERT INTO test_pipelines (name, graph) VALUES ('fix1', $1::jsonb)`,
      [JSON.stringify({ nodes: [{ id: 'q', stageType: 'llm_agent', capabilityKey: 'k' }], edges: [] })],
    )
    const sql = readFileSync(join(process.cwd(), 'src/db/schema-v44.sql'), 'utf8')
    await pool.query(sql)
    const r = await pool.query("SELECT graph FROM test_pipelines WHERE name='fix1'")
    expect(r.rows[0].graph.nodes[0].outputFormat).toBe('string')
  })

  it("旧 linear stages 字段：llm_agent 显式补 outputFormat='string'", async () => {
    const pool = getTestPool()
    // 插入 fixture pipeline，stages 字段（旧格式）含 llm_agent 节点（无 outputFormat）
    await pool.query(
      `INSERT INTO test_pipelines (name, stages) VALUES ('legacy', $1::jsonb)`,
      [JSON.stringify([{ id: 'q', stageType: 'llm_agent', capabilityKey: 'k' }])],
    )
    const sql = readFileSync(join(process.cwd(), 'src/db/schema-v44.sql'), 'utf8')
    await pool.query(sql)
    const r = await pool.query("SELECT stages FROM test_pipelines WHERE name='legacy'")
    expect(r.rows[0].stages[0].outputFormat).toBe('string')
  })

  it("edge.condition.expression 归一化：=== → ==、.includes() → contains", async () => {
    const pool = getTestPool()
    await pool.query(
      `INSERT INTO test_pipelines (name, graph) VALUES ('fix2', $1::jsonb)`,
      [JSON.stringify({
        nodes: [{ id: 'a', stageType: 'sql_query' }, { id: 'b', stageType: 'sql_query' }],
        edges: [
          { source: 'a', target: 'b', condition: { kind: 'expression', expression: "status === 'success'" } },
          { source: 'a', target: 'b', condition: { kind: 'expression', expression: "output.includes('FOO')" } },
        ],
      })],
    )
    const sql = readFileSync(join(process.cwd(), 'src/db/schema-v44.sql'), 'utf8')
    await pool.query(sql)
    const r = await pool.query("SELECT graph FROM test_pipelines WHERE name='fix2'")
    expect(r.rows[0].graph.edges[0].condition.expression).toBe("status == 'success'")
    expect(r.rows[0].graph.edges[1].condition.expression).toBe("output contains 'FOO'")
  })

  it('幂等：跑两次 v44 第二次 no-op', async () => {
    const pool = getTestPool()
    await pool.query(
      `INSERT INTO test_pipelines (name, graph) VALUES ('fix2', $1::jsonb)`,
      [JSON.stringify({
        nodes: [{ id: 'a', stageType: 'sql_query' }, { id: 'b', stageType: 'sql_query' }],
        edges: [
          { source: 'a', target: 'b', condition: { kind: 'expression', expression: "status === 'success'" } },
        ],
      })],
    )
    const sql = readFileSync(join(process.cwd(), 'src/db/schema-v44.sql'), 'utf8')
    await pool.query(sql)  // 第一次
    await pool.query(sql)  // 第二次（幂等，no-op）
    // 断言数据与第一次执行后一致
    const r = await pool.query("SELECT graph FROM test_pipelines WHERE name='fix2'")
    expect(r.rows[0].graph.edges[0].condition.expression).toBe("status == 'success'")
  })
})
