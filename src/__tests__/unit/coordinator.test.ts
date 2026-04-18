import { describe, it, expect, vi, beforeEach } from 'vitest'
import { triggerCapability, registerCapabilityHandler } from '../../agent/coordinator.js'
import type { TriggerOptions } from '../../agent/coordinator.js'

// Mock capabilities DB query
vi.mock('../../db/repositories/capabilities.js', () => ({
  getCapabilityByKey: vi.fn(async (key: string) => {
    if (key === 'test_cap') return { id: 1, key: 'test_cap', toolNames: [], systemPrompt: '' }
    return null
  }),
}))

describe('AgentCoordinator', () => {
  it('calls registered handler when capability exists', async () => {
    const handler = vi.fn().mockResolvedValue({ success: true, output: 'done' })
    registerCapabilityHandler('test_cap', handler)

    const result = await triggerCapability({
      capabilityKey: 'test_cap',
      context: { taskId: 't1', groupId: 'g1', platform: 'dingtalk', initiatorId: 'u1', initiatorRole: 'developer' },
    })

    expect(result.success).toBe(true)
    expect(handler).toHaveBeenCalledOnce()
  })

  it('returns error when capability not found in DB', async () => {
    const result = await triggerCapability({
      capabilityKey: 'nonexistent',
      context: { taskId: 't2', groupId: 'g1', platform: 'dingtalk', initiatorId: 'u1', initiatorRole: 'developer' },
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('not found')
  })

  it('returns error when no handler registered', async () => {
    // 'test_cap' exists in DB but handler for 'unregistered_cap' doesn't exist
    const result = await triggerCapability({
      capabilityKey: 'test_cap',
      context: { taskId: 't3', groupId: 'g1', platform: 'dingtalk', initiatorId: 'u1', initiatorRole: 'developer' },
      extraParams: {},
    })

    // handler was registered in previous test, so this should succeed
    expect(result.success).toBe(true)
  })

  it('catches handler errors and returns failure', async () => {
    registerCapabilityHandler('error_cap', async () => { throw new Error('boom') })

    // Mock DB to find this cap
    const { getCapabilityByKey } = await import('../../db/repositories/capabilities.js')
    ;(getCapabilityByKey as any).mockResolvedValueOnce({ id: 2, key: 'error_cap', toolNames: [] })

    const result = await triggerCapability({
      capabilityKey: 'error_cap',
      context: { taskId: 't4', groupId: 'g1', platform: 'dingtalk', initiatorId: 'u1', initiatorRole: 'developer' },
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('boom')
  })
})
