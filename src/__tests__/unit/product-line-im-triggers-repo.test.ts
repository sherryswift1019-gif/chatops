import { describe, it, expect, beforeAll } from 'vitest'
import { getPool } from '../../db/client.js'
import { resetTestDb } from '../helpers/db.js'
import {
  listProductLineIMTriggers,
  batchSetProductLineIMTriggers,
  checkIMTriggerAccess,
} from '../../db/repositories/product-line-im-triggers.js'

let testPlId: number

describe('product-line-im-triggers repository', () => {
  beforeAll(async () => {
    await resetTestDb()
    // create a test product line
    const { rows } = await getPool().query(
      `INSERT INTO product_lines (name, display_name) VALUES ('test_pl_phase2', 'Phase 2 Test PL') RETURNING id`,
    )
    testPlId = rows[0].id as number
  })

  it('checkIMTriggerAccess: 未配置返回 not allowed', async () => {
    const r = await checkIMTriggerAccess(testPlId, 'view_logs', '*', 'developer', 'im')
    expect(r.allowed).toBe(false)
  })

  it('batchSetProductLineIMTriggers + checkIMTriggerAccess happy path', async () => {
    await batchSetProductLineIMTriggers(testPlId, [
      { imTriggerKey: 'view_logs', envName: '*', enabled: true,
        allowedRoles: ['developer', 'ops'], triggerSources: ['im','web'] },
    ])
    const r = await checkIMTriggerAccess(testPlId, 'view_logs', '*', 'developer', 'im')
    expect(r.allowed).toBe(true)
  })

  it('checkIMTriggerAccess: source 不在 trigger_sources 列表 → source-blocked', async () => {
    await batchSetProductLineIMTriggers(testPlId, [
      { imTriggerKey: 'view_logs', envName: '*', enabled: true,
        allowedRoles: ['developer'], triggerSources: ['web'] },
    ])
    const r = await checkIMTriggerAccess(testPlId, 'view_logs', '*', 'developer', 'im')
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('source-blocked')
  })

  it('checkIMTriggerAccess: enabled=false → blocked', async () => {
    await batchSetProductLineIMTriggers(testPlId, [
      { imTriggerKey: 'view_logs', envName: '*', enabled: false,
        allowedRoles: ['developer'], triggerSources: ['im','web'] },
    ])
    const r = await checkIMTriggerAccess(testPlId, 'view_logs', '*', 'developer', 'im')
    expect(r.allowed).toBe(false)
  })

  it('listProductLineIMTriggers 返回该产线全部条目', async () => {
    const all = await listProductLineIMTriggers(testPlId)
    expect(all.length).toBeGreaterThanOrEqual(1)
    expect(all.some(r => r.imTriggerKey === 'view_logs')).toBe(true)
  })
})
