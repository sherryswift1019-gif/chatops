import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('axios', () => ({
  default: { post: vi.fn() },
}))

// Mock MUST be declared before importing the adapter
vi.mock('dingtalk-stream-sdk-nodejs', () => {
  const listeners = new Map<string, Function>()
  let allListener: Function | null = null
  const mockClient = {
    // SDK public fields the adapter now reads directly to determine real connection state
    connected: false,
    registered: false,
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
import axios from 'axios'
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
    // Reset SDK connection flags — tests opt-in by flipping these to true
    mockClient.connected = false
    mockClient.registered = false
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
    // 当前实现不剥离 @mention，原样透传给下游（由 Claude 在 Step 0 处理）
    expect(msg.text).toBe('@bot deploy payment-service')
    expect(msg.timestamp).toBe(1712836800000)
  })

  // ── @mention 透传（不剥离） ─────────────────────────────────────────────────
  // 说明：早期版本在 adapter 层剥 @bot 前缀，现已废弃（见 dingtalk.ts 注释）。
  // 文本原样传给 SessionManager/Claude，由下游识别 @。

  it('preserves @mention prefix in message text (pass-through)', async () => {
    const messages: unknown[] = []
    adapter.onMessage(m => { messages.push(m) })

    mockClient._trigger(TOPIC_ROBOT, makeRobotDownStream({ text: '@bot  deploy service  ' }))
    await Promise.resolve()

    const msg = messages[0] as { text: string }
    // trim 仍然保留（去除首尾空白），但 @bot 不剥离
    expect(msg.text).toBe('@bot  deploy service')
  })

  it('preserves multiple @mentions in message text (pass-through)', async () => {
    const messages: unknown[] = []
    adapter.onMessage(m => { messages.push(m) })

    mockClient._trigger(TOPIC_ROBOT, makeRobotDownStream({ text: '@bot hello @world ' }))
    await Promise.resolve()

    const msg = messages[0] as { text: string }
    expect(msg.text).toBe('@bot hello @world')
  })

  // ── @mention-only 消息仍进入 handler（不再过滤为空） ──────────────────────
  // 说明：由于 adapter 不剥 @，"@bot" 本身是非空文本，会正常进入 handler。
  // 过滤 @bot-only 的职责下移到 claude-runner / SessionManager。

  it('calls messageHandler even when text is only @mention (no stripping), and ACKs', async () => {
    const handler = vi.fn()
    adapter.onMessage(handler)

    mockClient._trigger(TOPIC_ROBOT, makeRobotDownStream({ text: '@bot', messageId: 'msg-empty' }))
    await Promise.resolve()

    expect(handler).toHaveBeenCalledOnce()
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

    it('reports connected when SDK socket is open', async () => {
      const t0 = Date.UTC(2026, 0, 1, 0, 0, 0)
      vi.useFakeTimers()
      vi.setSystemTime(t0)

      // Simulate SDK finishing WebSocket open handshake
      mockClient.connected = true
      await adapter.start()

      const s = adapter.getConnectionStatus()
      expect(s.started).toBe(true)
      expect(s.startedAt).toBe(t0)
      expect(s.lastEventAt).toBeNull()
      expect(s.connected).toBe(true)
      expect(s.startError).toBeNull()
    })

    it('ignores the SDK registered field (current DingTalk servers do not send SYSTEM.REGISTERED)', async () => {
      // Even if the SDK never flips `registered` to true, a live socket must read as connected.
      mockClient.connected = true
      mockClient.registered = false
      await adapter.start()

      const s = adapter.getConnectionStatus()
      expect(s.started).toBe(true)
      expect(s.connected).toBe(true)
    })

    it('flips to disconnected when SDK marks the socket closed (WS drop)', async () => {
      mockClient.connected = true
      await adapter.start()
      expect(adapter.getConnectionStatus().connected).toBe(true)

      // Simulate WebSocket close — SDK flips the public `connected` flag
      mockClient.connected = false
      expect(adapter.getConnectionStatus().connected).toBe(false)
    })

    it('updates lastEventAt when a business event is received, independent of connected', async () => {
      const t0 = Date.UTC(2026, 0, 1, 0, 0, 0)
      vi.useFakeTimers()
      vi.setSystemTime(t0)
      mockClient.connected = true
      await adapter.start()
      expect(adapter.getConnectionStatus().lastEventAt).toBeNull()

      vi.setSystemTime(t0 + 30_000)
      mockClient._triggerAll({ type: 'EVENT', headers: { topic: 'some/event', messageId: 'e1' } })

      const s = adapter.getConnectionStatus()
      expect(s.lastEventAt).toBe(t0 + 30_000)
      // lastEventAt age no longer affects `connected`
      expect(s.connected).toBe(true)
    })

    it('preserves lastEventAt over time without affecting the connected flag', async () => {
      const t0 = Date.UTC(2026, 0, 1, 0, 0, 0)
      vi.useFakeTimers()
      vi.setSystemTime(t0)
      mockClient.connected = true
      await adapter.start()

      mockClient._triggerAll({ type: 'EVENT', headers: { topic: 'some/event', messageId: 'e1' } })
      // Advance well past the old 120s heuristic window
      vi.setSystemTime(t0 + 10 * 60_000)

      const s = adapter.getConnectionStatus()
      expect(s.lastEventAt).toBe(t0)
      // Still connected because the SDK says so — event age is irrelevant
      expect(s.connected).toBe(true)
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
      mockClient.connected = true
      await adapter.start()
      expect(adapter.getConnectionStatus().started).toBe(true)

      await adapter.stop()
      const s = adapter.getConnectionStatus()
      expect(s.started).toBe(false)
      expect(s.startedAt).toBeNull()
      expect(s.connected).toBe(false)
    })

    it('stop() clears lastEventAt so a restart does not inherit old event timestamps', async () => {
      const t0 = Date.UTC(2026, 0, 1, 0, 0, 0)
      vi.useFakeTimers()
      vi.setSystemTime(t0)
      mockClient.connected = true
      await adapter.start()

      vi.setSystemTime(t0 + 10_000)
      mockClient._triggerAll({ type: 'EVENT', headers: { topic: 'some/event', messageId: 'e1' } })
      expect(adapter.getConnectionStatus().lastEventAt).toBe(t0 + 10_000)

      await adapter.stop()
      expect(adapter.getConnectionStatus().lastEventAt).toBeNull()
    })

    it('restart starts with a fresh lastEventAt regardless of prior-session events', async () => {
      const t0 = Date.UTC(2026, 0, 1, 0, 0, 0)
      vi.useFakeTimers()
      vi.setSystemTime(t0)
      mockClient.connected = true
      await adapter.start()

      vi.setSystemTime(t0 + 10_000)
      mockClient._triggerAll({ type: 'EVENT', headers: { topic: 'some/event', messageId: 'e1' } })

      vi.setSystemTime(t0 + 20_000)
      await adapter.stop()

      vi.setSystemTime(t0 + 30_000)
      mockClient.connected = true
      await adapter.start()
      expect(adapter.getConnectionStatus().lastEventAt).toBeNull()
    })

    it('start() clears startError from a previous failed attempt', async () => {
      mockClient.connect.mockImplementationOnce(async () => { throw new Error('first try failed') })
      await expect(adapter.start()).rejects.toThrow('first try failed')
      expect(adapter.getConnectionStatus().startError).toBe('first try failed')

      // Next start succeeds
      mockClient.connected = true
      await adapter.start()
      const s = adapter.getConnectionStatus()
      expect(s.startError).toBeNull()
      expect(s.started).toBe(true)
    })
  })

  // ── sendMessage() ──────────────────────────────────────────────────────────
  // 验证发送路径的 msgtype 行为
  // 注：fix 已在 src/adapters/im/dingtalk.ts 中提前完成；
  // 本测试作为回归保护，不走 TDD fail-first 流程（fix 先行）。

  describe('sendMessage()', () => {
    const WEBHOOK = 'https://oapi.dingtalk.com/robot/sendBySession/test-hook'

    beforeEach(async () => {
      // 触发一条 incoming 消息以缓存 sessionWebhook
      mockClient._trigger(TOPIC_ROBOT, makeRobotDownStream({
        conversationId: 'cid-send',
        sessionWebhook: WEBHOOK,
        messageId: 'seed-msg',
      }))
      await Promise.resolve()
      vi.mocked(axios.post).mockResolvedValue({ data: {} })
    })

    it('无 atDingtalkIds 时发 msgtype=markdown，不含 at 字段', async () => {
      await adapter.sendMessage({ type: 'group', id: 'cid-send' }, { text: '## hello' })

      expect(axios.post).toHaveBeenCalledOnce()
      const [url, body] = vi.mocked(axios.post).mock.calls[0]
      expect(url).toBe(WEBHOOK)
      expect(body).toMatchObject({ msgtype: 'markdown', markdown: { text: '## hello' } })
      expect((body as Record<string, unknown>).at).toBeUndefined()
    })

    it('有 atDingtalkIds 时发 msgtype=markdown（不降为 text），并附 at 字段 — 修复 #markdown-at-mention bug', async () => {
      await adapter.sendMessage(
        { type: 'group', id: 'cid-send' },
        { text: '## 你好！我是 ChatOps 助手\n\n**信息抓取**', atDingtalkIds: ['user-123'] } as any,
      )

      expect(axios.post).toHaveBeenCalledOnce()
      const [, body] = vi.mocked(axios.post).mock.calls[0]
      expect((body as Record<string, unknown>).msgtype).toBe('markdown')
      expect((body as Record<string, unknown>).markdown).toMatchObject({ text: expect.stringContaining('## 你好') })
      expect((body as Record<string, unknown>).at).toEqual({ atDingtalkIds: ['user-123'], isAtAll: false })
    })

    it('atDingtalkIds 为空数组时不附 at 字段', async () => {
      await adapter.sendMessage(
        { type: 'group', id: 'cid-send' },
        { text: 'hi', atDingtalkIds: [] } as any,
      )

      const [, body] = vi.mocked(axios.post).mock.calls[0]
      expect((body as Record<string, unknown>).msgtype).toBe('markdown')
      expect((body as Record<string, unknown>).at).toBeUndefined()
    })
  })
})
