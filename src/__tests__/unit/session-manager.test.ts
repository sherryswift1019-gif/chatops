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

  it('invokes processMessage for each received request', async () => {
    // 说明：ack 消息（"收到，处理中..."）的发送职责已从 SessionManager 下移到
    // claude-runner.ts 的 handler 路径（见 session-manager.ts 注释）。
    // 这里仅验证 SessionManager 正确路由消息到 processMessage。
    const processed: string[] = []
    const adapter = createMockAdapter('dingtalk')
    const manager = new SessionManager(
      [adapter],
      async (msg) => { processed.push(msg.text); await new Promise(r => setTimeout(r, 100)) }
    )
    manager.start()

    adapter.simulateMessage({ groupId: 'g1', text: 'deploy something' })

    await vi.waitFor(() => {
      expect(processed).toContain('deploy something')
    }, { timeout: 2000 })
  })
})
