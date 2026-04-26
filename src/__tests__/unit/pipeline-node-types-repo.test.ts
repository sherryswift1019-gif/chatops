import { describe, it, expect } from 'vitest'
import {
  listNodeTypes,
  getNodeType,
  listEnabledNodeTypeKeys,
} from '../../db/repositories/pipeline-node-types.js'

// 注：迁移由 vitest globalSetup（src/__tests__/setup/pg-container.ts）顺序应用
// 全部 schema*.sql 文件，含 v30 (5 phase-0 行) 与 v34 (7 phase-3 行,默认 disabled)。
// 本测试仅验证 repository 行为。
describe('pipeline-node-types repository', () => {
  it('lists all 12 seeded node types (5 phase-0 + 7 phase-3)', async () => {
    const types = await listNodeTypes()
    const keys = types.map(t => t.key).sort()
    expect(keys).toEqual([
      'approval',
      'capability',
      'db_update',
      'dm',
      'fan_out',
      'file_read',
      'http',
      'im_input',
      'script',
      'sql_query',
      'template_render',
      'wait_webhook',
    ])
  })

  it('getNodeType returns null for unknown key', async () => {
    expect(await getNodeType('nonexistent')).toBeNull()
  })

  it('getNodeType returns parsed param_schema as object', async () => {
    const t = await getNodeType('script')
    expect(t).not.toBeNull()
    expect(typeof t!.paramSchema).toBe('object')
    expect(t!.category).toBe('general')
  })

  it('listEnabledNodeTypeKeys returns enabled-only set (5 phase-0 types; 7 phase-3 still disabled)', async () => {
    const keys = await listEnabledNodeTypeKeys()
    expect(keys.size).toBe(5)
    expect(keys.has('script')).toBe(true)
    // phase-3 types must NOT be in the enabled set until T9-T15 enable them
    expect(keys.has('http')).toBe(false)
    expect(keys.has('fan_out')).toBe(false)
  })
})
