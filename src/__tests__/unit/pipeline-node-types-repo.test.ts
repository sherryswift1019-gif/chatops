import { describe, it, expect } from 'vitest'
import {
  listNodeTypes,
  getNodeType,
  listEnabledNodeTypeKeys,
} from '../../db/repositories/pipeline-node-types.js'

// 注：迁移由 vitest globalSetup（src/__tests__/setup/pg-container.ts）顺序应用
// 全部 schema*.sql 文件，含 v30。本测试仅验证 repository 行为。
describe('pipeline-node-types repository', () => {
  it('lists all 5 seeded node types', async () => {
    const types = await listNodeTypes()
    const keys = types.map(t => t.key).sort()
    expect(keys).toEqual(['approval', 'capability', 'im_input', 'script', 'wait_webhook'])
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

  it('listEnabledNodeTypeKeys returns enabled-only set', async () => {
    const keys = await listEnabledNodeTypeKeys()
    expect(keys.size).toBe(5)
    expect(keys.has('script')).toBe(true)
  })
})
