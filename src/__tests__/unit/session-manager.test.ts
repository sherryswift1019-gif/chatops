import { describe, it, expect, beforeEach, vi } from 'vitest'
import { resetTestDb } from '../helpers/db.js'
import { createMockAdapter } from '../helpers/im.js'
import { SessionManager } from '../../agent/session-manager.js'

beforeEach(async () => { await resetTestDb() })

describe('SessionManager', () => {
  it('routes messages from different groups to separate queues', async () => {
    const handled: string[] = []
    const adapter = createMockAdapter('dingtalk')
    const manager = new SessionManager(
      [adapter],
      async (msg, _queue) => { handled.push(msg.groupId) }
    )
    manager.start()

    adapter.simulateMessage({ groupId: 'g1', text: 'hello' })
    adapter.simulateMessage({ groupId: 'g2', text: 'world' })

    await vi.waitFor(() => {
      expect(handled).toContain('g1')
      expect(handled).toContain('g2')
    }, { timeout: 2000 })
  })

  it('sends immediate ack message on receiving a request', async () => {
    const adapter = createMockAdapter('dingtalk')
    const manager = new SessionManager(
      [adapter],
      async () => { await new Promise(r => setTimeout(r, 100)) }
    )
    manager.start()

    adapter.simulateMessage({ groupId: 'g1', text: 'deploy something' })

    await vi.waitFor(() => {
      expect(adapter.sentMessages.length).toBeGreaterThan(0)
      const ack = adapter.sentMessages[0].content as { text: string }
      expect(ack.text).toContain('收到')
    }, { timeout: 2000 })
  })
})
