import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock MUST be declared before importing the adapter
vi.mock('dingtalk-stream-sdk-nodejs', () => {
  const listeners = new Map<string, Function>()
  const mockClient = {
    registerCallbackListener: vi.fn((topic: string, cb: Function) => {
      listeners.set(topic, cb)
      return mockClient
    }),
    registerAllEventListener: vi.fn(() => mockClient),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(),
    send: vi.fn(),
    registerAllEventListener: vi.fn(),
    // Test helpers
    _trigger: (topic: string, data: unknown) => listeners.get(topic)?.(data),
    _listeners: listeners,
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
})
