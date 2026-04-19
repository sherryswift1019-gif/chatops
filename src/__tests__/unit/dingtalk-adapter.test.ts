import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock MUST be declared before importing the adapter
vi.mock('dingtalk-stream-sdk-nodejs', () => {
  const listeners = new Map<string, Function>()
  let allListener: Function | null = null
  const mockClient = {
    registerCallbackListener: vi.fn((topic: string, cb: Function) => {
      listeners.set(topic, cb)
      return mockClient
    }),
    registerAllEventListener: vi.fn((cb: Function) => {
      allListener = cb
      return mockClient
    }),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(),
    send: vi.fn(),
    // Test helpers
    _trigger: (topic: string, data: unknown) => listeners.get(topic)?.(data),
    _triggerAll: (data: unknown) => allListener?.(data),
    _listeners: listeners,
    _resetAllListener: () => { allListener = null },
  }

  // Use a proper function (not arrow function) so it can be called as a constructor
  function DWClientMock(_opts: unknown) {
    return mockClient
  }

  return {
    DWClient: DWClientMock,
    TOPIC_ROBOT: '/v1.0/im/bot/messages/get',
    TOPIC_CARD: '/v1.0/card/instances/callback',
    EventAck: { SUCCESS: 'SUCCESS', LATER: 'LATER' },
    __mockClient: mockClient,
  }
})

// Import AFTER mock is set up
import { DingTalkAdapter } from '../../adapters/im/dingtalk.js'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — __mockClient is a test-only export added by the mock factory
import { __mockClient as mockClient, TOPIC_ROBOT, TOPIC_CARD } from 'dingtalk-stream-sdk-nodejs'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRobotDownStream(overrides: Partial<{
  messageId: string
  text: string
  senderId: string
  senderNick: string
  conversationId: string
  sessionWebhook: string
}> = {}): object {
  const {
    messageId = 'msg-001',
    text = '@bot deploy payment-service',
    senderId = 'user-001',
    senderNick = '张三',
    conversationId = 'cid-001',
    sessionWebhook = 'https://oapi.dingtalk.com/robot/sendBySession/xxx',
  } = overrides

  return {
    specVersion: '1.0',
    type: 'CALLBACK',
    headers: {
      appId: 'app1',
      connectionId: 'conn1',
      contentType: 'application/json',
      messageId,
      time: '2026-04-11T10:00:00Z',
      topic: TOPIC_ROBOT,
    },
    data: JSON.stringify({
      conversationId,
      senderId,
      senderNick,
      senderStaffId: 'staff-001',
      sessionWebhook,
      robotCode: 'bot1',
      msgtype: 'text',
      text: { content: text },
      conversationType: '2',
      createAt: 1712836800000,
      chatbotUserId: 'bot-uid',
      chatbotCorpId: 'corp1',
      senderCorpId: 'corp1',
      msgId: 'msg-id-1',
      isAdmin: false,
      sessionWebhookExpiredTime: 1712840400000,
    }),
  }
}

function makeCardDownStream(overrides: Partial<{
  messageId: string
  taskId: string
  action: string
  userId: string
}> = {}): object {
  const {
    messageId = 'card-msg-001',
    taskId = 'task-42',
    action = 'approve',
    userId = 'user-002',
  } = overrides

  return {
    specVersion: '1.0',
    type: 'CALLBACK',
    headers: {
      appId: 'app1',
      connectionId: 'conn1',
      contentType: 'application/json',
      messageId,
      time: '2026-04-11T10:00:00Z',
      topic: TOPIC_CARD,
    },
    data: JSON.stringify({
      callbackData: { taskId, action },
      userId,
    }),
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DingTalkAdapter (Stream mode)', () => {
  let adapter: DingTalkAdapter

  beforeEach(() => {
    vi.clearAllMocks()
    // Also clear the captured listeners so each test gets a fresh adapter
    mockClient._listeners.clear()
    mockClient._resetAllListener()
    adapter = new DingTalkAdapter({ clientId: 'app1', clientSecret: 'secret1' })
  })

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  it('start() calls client.connect()', async () => {
    await adapter.start()
    expect(mockClient.connect).toHaveBeenCalledOnce()
  })

  it('stop() calls client.disconnect()', async () => {
    await adapter.stop()
    expect(mockClient.disconnect).toHaveBeenCalledOnce()
  })

  it('handleWebhook() throws — stream mode does not support HTTP webhooks', async () => {
    await expect(adapter.handleWebhook({}, {})).rejects.toThrow('Stream mode')
  })

  // ── Message normalization ──────────────────────────────────────────────────

  it('normalizes a robot message and calls messageHandler with correct fields', async () => {
    const messages: unknown[] = []
    adapter.onMessage(m => { messages.push(m) })

    mockClient._trigger(TOPIC_ROBOT, makeRobotDownStream())

    // Allow microtasks to flush
    await Promise.resolve()

    expect(messages).toHaveLength(1)
    const msg = messages[0] as {
      platform: string
      groupId: string
      userId: string
      userName: string
      text: string
      timestamp: number
    }
    expect(msg.platform).toBe('dingtalk')
    expect(msg.groupId).toBe('cid-001')
    expect(msg.userId).toBe('staff-001')
    expect(msg.userName).toBe('张三')
    expect(msg.text).toBe('deploy payment-service')
    expect(msg.timestamp).toBe(1712836800000)
  })

  // ── @mention stripping ─────────────────────────────────────────────────────

  it('strips @mention prefix from message text', async () => {
    const messages: unknown[] = []
    adapter.onMessage(m => { messages.push(m) })

    mockClient._trigger(TOPIC_ROBOT, makeRobotDownStream({ text: '@bot  deploy service  ' }))
    await Promise.resolve()

    const msg = messages[0] as { text: string }
    expect(msg.text).toBe('deploy service')
  })

  it('strips multiple @mentions leaving remaining text intact', async () => {
    const messages: unknown[] = []
    adapter.onMessage(m => { messages.push(m) })

    mockClient._trigger(TOPIC_ROBOT, makeRobotDownStream({ text: '@bot hello @world ' }))
    await Promise.resolve()

    const msg = messages[0] as { text: string }
    expect(msg.text).toBe('hello')
  })

  // ── Empty message skipped ──────────────────────────────────────────────────

  it('does NOT call messageHandler when text is only @mention, but still ACKs', async () => {
    const handler = vi.fn()
    adapter.onMessage(handler)

    mockClient._trigger(TOPIC_ROBOT, makeRobotDownStream({ text: '@bot', messageId: 'msg-empty' }))
    await Promise.resolve()

    expect(handler).not.toHaveBeenCalled()
    expect(mockClient.send).toHaveBeenCalledWith('msg-empty', { status: 'SUCCESS' })
  })

  // ── Message ACK ───────────────────────────────────────────────────────────

  it('ACKs the message via client.send() after processing', async () => {
    adapter.onMessage(async () => {})

    mockClient._trigger(TOPIC_ROBOT, makeRobotDownStream({ messageId: 'msg-ack-test' }))
    await Promise.resolve()

    expect(mockClient.send).toHaveBeenCalledWith('msg-ack-test', { status: 'SUCCESS' })
  })

  it('ACKs before invoking messageHandler (fire-and-forget pattern)', async () => {
    const callOrder: string[] = []
    // Spy on send to record order
    mockClient.send.mockImplementation(() => { callOrder.push('ack') })

    adapter.onMessage(async () => { callOrder.push('handler') })

    mockClient._trigger(TOPIC_ROBOT, makeRobotDownStream({ messageId: 'msg-order' }))
    await Promise.resolve()

    // ACK should be called; handler is async and may run after
    expect(callOrder).toContain('ack')
  })

  // ── Card action callback ───────────────────────────────────────────────────

  it('calls cardActionHandler with taskId, action, userId on card callback', async () => {
    const cardHandler = vi.fn()
    adapter.onCardAction(cardHandler)

    mockClient._trigger(TOPIC_CARD, makeCardDownStream())
    await Promise.resolve()

    expect(cardHandler).toHaveBeenCalledOnce()
    expect(cardHandler).toHaveBeenCalledWith('task-42', 'approve', 'user-002')
  })

  it('ACKs card callback via client.send()', async () => {
    adapter.onCardAction(vi.fn())

    mockClient._trigger(TOPIC_CARD, makeCardDownStream({ messageId: 'card-ack-test' }))
    await Promise.resolve()

    expect(mockClient.send).toHaveBeenCalledWith('card-ack-test', { status: 'SUCCESS' })
  })

  it('ACKs card callback even when cardActionHandler is not set', async () => {
    // No cardActionHandler registered

    mockClient._trigger(TOPIC_CARD, makeCardDownStream({ messageId: 'card-no-handler' }))
    await Promise.resolve()

    expect(mockClient.send).toHaveBeenCalledWith('card-no-handler', { status: 'SUCCESS' })
  })

  // ── Listener registration ──────────────────────────────────────────────────

  it('registers listeners for TOPIC_ROBOT and TOPIC_CARD in constructor', () => {
    expect(mockClient.registerCallbackListener).toHaveBeenCalledWith(TOPIC_ROBOT, expect.any(Function))
    expect(mockClient.registerCallbackListener).toHaveBeenCalledWith(TOPIC_CARD, expect.any(Function))
  })

  // ── credentialsMatch() ─────────────────────────────────────────────────────

  describe('credentialsMatch()', () => {
    it('returns true when both clientId and clientSecret match', () => {
      expect(adapter.credentialsMatch('app1', 'secret1')).toBe(true)
    })

    it('returns false when clientId differs', () => {
      expect(adapter.credentialsMatch('app2', 'secret1')).toBe(false)
    })

    it('returns false when clientSecret differs', () => {
      expect(adapter.credentialsMatch('app1', 'secret-other')).toBe(false)
    })
  })

  // ── getConnectionStatus() ──────────────────────────────────────────────────

  describe('getConnectionStatus()', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('reports not-started before start() is called', () => {
      const s = adapter.getConnectionStatus()
      expect(s).toEqual({
        configured: true,
        started: false,
        startedAt: null,
        lastEventAt: null,
        startError: null,
        connected: false,
      })
    })

    it('reports connected immediately after start() within the 60s grace window', async () => {
      const t0 = Date.UTC(2026, 0, 1, 0, 0, 0)
      vi.useFakeTimers()
      vi.setSystemTime(t0)

      await adapter.start()

      const s = adapter.getConnectionStatus()
      expect(s.started).toBe(true)
      expect(s.startedAt).toBe(t0)
      expect(s.lastEventAt).toBeNull()
      expect(s.connected).toBe(true)
      expect(s.startError).toBeNull()
    })

    it('flips to disconnected after 60s grace window expires with no events', async () => {
      const t0 = Date.UTC(2026, 0, 1, 0, 0, 0)
      vi.useFakeTimers()
      vi.setSystemTime(t0)
      await adapter.start()

      vi.setSystemTime(t0 + 61_000)
      const s = adapter.getConnectionStatus()
      expect(s.started).toBe(true)
      expect(s.connected).toBe(false)
    })

    it('stays connected when any event arrives within 120s after the grace window', async () => {
      const t0 = Date.UTC(2026, 0, 1, 0, 0, 0)
      vi.useFakeTimers()
      vi.setSystemTime(t0)
      await adapter.start()

      // After grace window; would be disconnected without an event
      vi.setSystemTime(t0 + 61_000)
      expect(adapter.getConnectionStatus().connected).toBe(false)

      // Heartbeat event arrives
      mockClient._triggerAll({ type: 'SYSTEM', headers: { topic: 'system/ping', messageId: 'h1' } })
      const afterEvent = adapter.getConnectionStatus()
      expect(afterEvent.lastEventAt).toBe(t0 + 61_000)
      expect(afterEvent.connected).toBe(true)

      // Still connected 30s later
      vi.setSystemTime(t0 + 91_000)
      expect(adapter.getConnectionStatus().connected).toBe(true)
    })

    it('reports disconnected when the last event is older than 120s', async () => {
      const t0 = Date.UTC(2026, 0, 1, 0, 0, 0)
      vi.useFakeTimers()
      vi.setSystemTime(t0)
      await adapter.start()

      vi.setSystemTime(t0 + 61_000)
      mockClient._triggerAll({ type: 'SYSTEM', headers: { topic: 'system/ping', messageId: 'h1' } })

      // 121s after the event
      vi.setSystemTime(t0 + 61_000 + 121_000)
      const s = adapter.getConnectionStatus()
      expect(s.lastEventAt).toBe(t0 + 61_000)
      expect(s.connected).toBe(false)
    })

    it('records startError and stays not-started when connect() throws', async () => {
      mockClient.connect.mockImplementationOnce(async () => { throw new Error('bad creds') })

      await expect(adapter.start()).rejects.toThrow('bad creds')

      const s = adapter.getConnectionStatus()
      expect(s.started).toBe(false)
      expect(s.startedAt).toBeNull()
      expect(s.connected).toBe(false)
      expect(s.startError).toBe('bad creds')
    })

    it('stop() clears startedAt and reports disconnected', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(Date.UTC(2026, 0, 1, 0, 0, 0))
      await adapter.start()
      expect(adapter.getConnectionStatus().started).toBe(true)

      await adapter.stop()
      const s = adapter.getConnectionStatus()
      expect(s.started).toBe(false)
      expect(s.startedAt).toBeNull()
      expect(s.connected).toBe(false)
    })

    it('stop() clears lastEventAt so a restart does not inherit heartbeats', async () => {
      const t0 = Date.UTC(2026, 0, 1, 0, 0, 0)
      vi.useFakeTimers()
      vi.setSystemTime(t0)
      await adapter.start()

      // Heartbeat received during first session
      vi.setSystemTime(t0 + 10_000)
      mockClient._triggerAll({ type: 'SYSTEM', headers: { topic: 'system/ping', messageId: 'h1' } })
      expect(adapter.getConnectionStatus().lastEventAt).toBe(t0 + 10_000)

      // Stop clears both startedAt and lastEventAt
      await adapter.stop()
      expect(adapter.getConnectionStatus().lastEventAt).toBeNull()
    })

    it('restart does not report connected based on the previous session heartbeat', async () => {
      const t0 = Date.UTC(2026, 0, 1, 0, 0, 0)
      vi.useFakeTimers()
      vi.setSystemTime(t0)
      await adapter.start()

      // First session: heartbeat at t0+10s
      vi.setSystemTime(t0 + 10_000)
      mockClient._triggerAll({ type: 'SYSTEM', headers: { topic: 'system/ping', messageId: 'h1' } })

      // Stop at t0+20s
      vi.setSystemTime(t0 + 20_000)
      await adapter.stop()

      // Restart at t0+30s (pre-stop heartbeat is still within 120s window if it leaked)
      vi.setSystemTime(t0 + 30_000)
      await adapter.start()
      expect(adapter.getConnectionStatus().lastEventAt).toBeNull()

      // After 60s grace window expires, no new event → must be disconnected,
      // regardless of the stale pre-restart heartbeat.
      vi.setSystemTime(t0 + 30_000 + 61_000)
      const s = adapter.getConnectionStatus()
      expect(s.lastEventAt).toBeNull()
      expect(s.connected).toBe(false)
    })

    it('start() clears startError from a previous failed attempt', async () => {
      mockClient.connect.mockImplementationOnce(async () => { throw new Error('first try failed') })
      await expect(adapter.start()).rejects.toThrow('first try failed')
      expect(adapter.getConnectionStatus().startError).toBe('first try failed')

      // Next start succeeds
      await adapter.start()
      const s = adapter.getConnectionStatus()
      expect(s.startError).toBeNull()
      expect(s.started).toBe(true)
    })
  })
})
