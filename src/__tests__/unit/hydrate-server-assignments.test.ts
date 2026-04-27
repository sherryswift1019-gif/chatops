import { describe, it, expect, beforeEach } from 'vitest'
import { resetTestDb, getTestPool } from '../helpers/db.js'
import { hydrateServerAssignments } from '../../pipeline/executor.js'

describe('hydrateServerAssignments', () => {
  let pl1: number
  let serverIds: number[]

  beforeEach(async () => {
    await resetTestDb()
    const pool = getTestPool()
    pl1 = (await pool.query(`INSERT INTO product_lines (name, display_name, description) VALUES ('pl-test', '', '') RETURNING id`)).rows[0].id
    serverIds = []
    for (const role of ['web', 'web', 'db']) {
      const res = await pool.query(
        `INSERT INTO test_servers (product_line_id, host, port, username, role, name)
         VALUES ($1, 'h.example.com', 22, 'r', $2, $3) RETURNING id`,
        [pl1, role, `s-${role}-${Math.random()}`],
      )
      serverIds.push(res.rows[0].id)
    }
  })

  it('从 server id list hydrate 为 ServerInfo[]', async () => {
    const result = await hydrateServerAssignments({
      web: [String(serverIds[0]), String(serverIds[1])],
      db: [String(serverIds[2])],
    })
    expect(Object.keys(result).sort()).toEqual(['db', 'web'])
    expect(result.web).toHaveLength(2)
    expect(result.db).toHaveLength(1)
  })

  it('空 assignments 返回空对象', async () => {
    expect(await hydrateServerAssignments({})).toEqual({})
  })

  it('server id 不存在 → 报错', async () => {
    await expect(hydrateServerAssignments({ web: ['99999999'] })).rejects.toThrow(/not found/i)
  })
})
