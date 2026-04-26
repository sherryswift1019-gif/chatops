import { describe, it, expect } from 'vitest'
import { listNodeTypes } from '../../db/repositories/pipeline-node-types.js'

describe('admin /pipeline-node-types data shape', () => {
  it('returns 5 enabled types covering 3 categories', async () => {
    const items = (await listNodeTypes()).filter(t => t.enabled)
    expect(items).toHaveLength(5)
    const byCategory = new Map<string, number>()
    for (const t of items) byCategory.set(t.category, (byCategory.get(t.category) ?? 0) + 1)
    expect(byCategory.get('general')).toBe(1)   // script
    expect(byCategory.get('flow')).toBe(3)      // approval / wait_webhook / im_input
    expect(byCategory.get('llm')).toBe(1)       // capability
  })

  it('paramSchema is parsed object on every type', async () => {
    const items = await listNodeTypes()
    for (const t of items) {
      expect(typeof t.paramSchema).toBe('object')
      expect(t.paramSchema).not.toBeNull()
    }
  })
})
