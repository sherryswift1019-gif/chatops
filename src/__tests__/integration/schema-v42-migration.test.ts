import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { resetTestDb, getTestPool } from '../helpers/db.js'
import { listPipelineBindings } from '../../db/repositories/pipeline-bindings.js'

async function seedPreV42State(): Promise<{ pl1: number; pl2: number; p1: number; p2: number; p3: number }> {
  const pool = getTestPool()

  const pl1 = (await pool.query(
    `INSERT INTO product_lines (name, display_name, description) VALUES ('pl-1', 'PL1', '') RETURNING id`,
  )).rows[0].id
  const pl2 = (await pool.query(
    `INSERT INTO product_lines (name, display_name, description) VALUES ('pl-2', 'PL2', '') RETURNING id`,
  )).rows[0].id

  for (const pl of [pl1, pl2]) {
    for (let i = 0; i < 3; i++) {
      await pool.query(
        `INSERT INTO test_servers (product_line_id, host, port, username, role, name, key_path)
         VALUES ($1, $2, 22, 'root', 'web', $3, '')`,
        [pl, `web${i}-pl${pl}.example.com`, `web${i}-pl${pl}`],
      )
    }
    await pool.query(
      `INSERT INTO test_servers (product_line_id, host, port, username, role, name, key_path)
       VALUES ($1, $2, 22, 'root', 'db', $3, '')`,
      [pl, `db-pl${pl}.example.com`, `db-pl${pl}`],
    )
  }

  const p1 = (await pool.query(
    `INSERT INTO test_pipelines (product_line_id, name, description, graph, trigger_params, enabled, server_roles, variables, stages)
     VALUES ($1, 'L1-配置类', '', '{"nodes":[],"edges":[]}'::jsonb, '{}'::jsonb, true, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb)
     RETURNING id`,
    [pl1],
  )).rows[0].id
  const p2 = (await pool.query(
    `INSERT INTO test_pipelines (product_line_id, name, description, graph, trigger_params, enabled, server_roles, variables, stages)
     VALUES ($1, 'L3-业务逻辑', '', '{"nodes":[],"edges":[]}'::jsonb, '{}'::jsonb, true, '{"web":2,"db":1}'::jsonb, '{}'::jsonb, '[]'::jsonb)
     RETURNING id`,
    [pl1],
  )).rows[0].id
  const p3 = (await pool.query(
    `INSERT INTO test_pipelines (product_line_id, name, description, graph, trigger_params, enabled, server_roles, variables, stages)
     VALUES ($1, 'L1-配置类', '', '{"nodes":[],"edges":[]}'::jsonb, '{}'::jsonb, true, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb)
     RETURNING id`,
    [pl2],
  )).rows[0].id

  return { pl1, pl2, p1, p2, p3 }
}

describe('schema-v42 数据迁移', () => {
  beforeEach(async () => {
    await resetTestDb()
  })

  it('每条产线绑定 pipeline 自动建一条 binding', async () => {
    const fx = await seedPreV42State()
    const sql = readFileSync(join(process.cwd(), 'src/db/schema-v42.sql'), 'utf8')
    await getTestPool().query(sql)

    const bindings = await listPipelineBindings()
    expect(bindings).toHaveLength(3)

    const l1Bindings = bindings.filter(b => b.refKey === 'fix_bug_l1')
    expect(l1Bindings).toHaveLength(2)
    expect(l1Bindings.map(b => b.productLineId).sort()).toEqual([fx.pl1, fx.pl2].sort())

    const l3 = bindings.find(b => b.refKey === 'fix_bug_l3')
    expect(l3).toBeDefined()
    expect(l3!.pipelineId).toBe(fx.p2)
  })

  it('server_roles {web:2,db:1} 自动转换为 server id 列表', async () => {
    const fx = await seedPreV42State()
    const sql = readFileSync(join(process.cwd(), 'src/db/schema-v42.sql'), 'utf8')
    await getTestPool().query(sql)

    const l3 = (await listPipelineBindings()).find(b => b.refKey === 'fix_bug_l3')
    expect(l3!.serverRoleAssignments).toMatchObject({
      web: expect.arrayContaining([expect.any(String)]),
      db: expect.arrayContaining([expect.any(String)]),
    })
    expect((l3!.serverRoleAssignments.web as string[]).length).toBe(2)
    expect((l3!.serverRoleAssignments.db as string[]).length).toBe(1)
  })

  it('server_roles 为空 {} 的 pipeline → assignments 也是 {}', async () => {
    const fx = await seedPreV42State()
    const sql = readFileSync(join(process.cwd(), 'src/db/schema-v42.sql'), 'utf8')
    await getTestPool().query(sql)

    const l1 = (await listPipelineBindings()).find(b => b.productLineId === fx.pl1 && b.refKey === 'fix_bug_l1')
    expect(l1!.serverRoleAssignments).toEqual({})
  })

  it('internal pipeline 不迁移到 pipeline_bindings', async () => {
    const fx = await seedPreV42State()
    const pool = getTestPool()
    await pool.query(
      `INSERT INTO internal_capability_pipelines (capability_key, pipeline_id) VALUES ('test_internal', $1) ON CONFLICT DO NOTHING`,
      [fx.p1],
    )
    const sql = readFileSync(join(process.cwd(), 'src/db/schema-v42.sql'), 'utf8')
    await pool.query(sql)

    const bindings = await listPipelineBindings()
    expect(bindings.find(b => b.pipelineId === fx.p1)).toBeUndefined()
    expect(bindings).toHaveLength(2)

    const r = await pool.query(`SELECT product_line_id FROM test_pipelines WHERE id = $1`, [fx.p1])
    expect(r.rows[0].product_line_id).toBeNull()
  })
})
