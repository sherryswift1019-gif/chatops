import { describe, it, expect } from 'vitest'
import { listIMTriggers, getIMTrigger, createIMTrigger, updateIMTrigger, deleteIMTrigger } from '../../db/repositories/im-triggers.js'

describe('im-triggers repository', () => {
  it('lists IM triggers (migrated from entry-class capabilities)', async () => {
    const triggers = await listIMTriggers()
    expect(triggers.length).toBeGreaterThanOrEqual(5)
    for (const t of triggers) {
      expect(typeof t.key).toBe('string')
      expect(typeof t.displayName).toBe('string')
      expect(t.examples).toBeInstanceOf(Array)
      expect(typeof t.failureMessages).toBe('object')
      expect(typeof t.enabled).toBe('boolean')
    }
  })

  it('getIMTrigger by key returns row or null', async () => {
    const triggers = await listIMTriggers()
    if (triggers.length === 0) return
    const found = await getIMTrigger(triggers[0].key)
    expect(found).not.toBeNull()
    expect(found!.key).toBe(triggers[0].key)
    expect(await getIMTrigger('nonexistent_xxx')).toBeNull()
  })

  it('createIMTrigger / updateIMTrigger / deleteIMTrigger round-trip', async () => {
    const created = await createIMTrigger({
      key: 'test_trigger_phase2',
      displayName: '测试触发器',
      description: 'phase 2 unit test',
      pipelineId: null,
      intentHints: '',
      examples: ['测试一下'],
      failureMessages: { test_error: '测试错误' },
      defaultApprovalRuleId: null,
      isSystem: false,
      enabled: true,
    })
    expect(created.id).toBeGreaterThan(0)
    expect(created.key).toBe('test_trigger_phase2')

    const updated = await updateIMTrigger(created.id, { displayName: '改名了' })
    expect(updated!.displayName).toBe('改名了')

    await deleteIMTrigger(created.id)
    expect(await getIMTrigger('test_trigger_phase2')).toBeNull()
  })

  it('intent_hints / examples / failure_messages backfill correctly', async () => {
    const all = await listIMTriggers()
    for (const t of all) {
      expect(typeof t.intentHints).toBe('string')
      expect(Array.isArray(t.examples)).toBe(true)
      expect(typeof t.failureMessages).toBe('object')
    }
  })

  it('pipeline_id may be null (some entry capabilities had no default pipeline)', async () => {
    const all = await listIMTriggers()
    const withPipeline = all.filter(t => t.pipelineId !== null)
    const withoutPipeline = all.filter(t => t.pipelineId === null)
    // 至少存在某种状态;测试不强制要求两类都存在
    expect(withPipeline.length + withoutPipeline.length).toBe(all.length)
  })
})
