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

  it('listEnabledNodeTypeKeys returns enabled-only set (5 phase-0 + T9-T15 全部启用 = 12)', async () => {
    const keys = await listEnabledNodeTypeKeys()
    // phase-0 5 + phase-3 7 (http/dm/db_update/sql_query/file_read/template_render/fan_out)
    expect(keys.has('script')).toBe(true)
    expect(keys.has('approval')).toBe(true)
    expect(keys.has('capability')).toBe(true)
    expect(keys.has('wait_webhook')).toBe(true)
    expect(keys.has('im_input')).toBe(true)
    // phase-3 T9-T14
    expect(keys.has('http')).toBe(true)
    expect(keys.has('dm')).toBe(true)
    expect(keys.has('db_update')).toBe(true)
    expect(keys.has('sql_query')).toBe(true)
    expect(keys.has('file_read')).toBe(true)
    expect(keys.has('template_render')).toBe(true)
    // T15 fan_out 现已启用
    expect(keys.has('fan_out')).toBe(true)
    expect(keys.size).toBe(12)
  })
})
