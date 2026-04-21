/**
 * Unit test: DingTalk interactive card 发送 + 回传解析
 *
 * 背景：dingtalk.ts 现有测试（dingtalk-adapter.test.ts）不 mock axios，
 * 覆盖不到 sendDirectMessage HTTP 路径。本文件专门测互动卡片相关两件事：
 *   1. sendDirectMessage(content=InteractiveCard) → POST /v1.0/card/instances/createAndDeliver
 *      - URL / outTrackId / cardTemplateId / cardParamMap / openSpaceId 正确
 *      - 未配 DINGTALK_L3_CARD_TEMPLATE_ID 时降级为文字
 *   2. handleCardCallback 解析新格式（action: { id: 'agree' } / outTrackId）和旧格式（callbackData.{taskId, action}）
 *      双向兼容
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// 先 mock dingtalk-stream-sdk（和 dingtalk-adapter.test.ts 一致的骨架）
vi.mock('dingtalk-stream-sdk-nodejs', () => {
  const listeners = new Map<string, Function>()
  const mockClient = {
    connected: false,
    registered: false,
    registerCallbackListener: vi.fn((topic: string, cb: Function) => {
      listeners.set(topic, cb)
      return mockClient
    }),
    registerAllEventListener: vi.fn(() => mockClient),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(),
    send: vi.fn(),
    _trigger: (topic: string, data: unknown) => listeners.get(topic)?.(data),
  }
  function DWClientMock(_opts: unknown) { return mockClient }
  return {
    DWClient: DWClientMock,
    TOPIC_ROBOT: '/v1.0/im/bot/messages/get',
    TOPIC_CARD: '/v1.0/card/instances/callback',
    EventAck: { SUCCESS: 'SUCCESS', LATER: 'LATER' },
    __mockClient: mockClient,
  }
})

// 再 mock axios — 分别 stub post / get（getAccessToken 用 post）
vi.mock('axios', () => ({
  default: {
    post: vi.fn(),
    get: vi.fn(),
  },
}))

import axios from 'axios'
import { DingTalkAdapter } from '../../adapters/im/dingtalk.js'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { __mockClient as mockClient, TOPIC_CARD } from 'dingtalk-stream-sdk-nodejs'

describe('DingTalk InteractiveCard send', () => {
  let adapter: DingTalkAdapter
  const originalTemplateId = process.env.DINGTALK_L3_CARD_TEMPLATE_ID

  beforeEach(() => {
    vi.mocked(axios.post).mockReset()
    // getAccessToken 走 axios.post('.../gettoken', ...)，默认让它返回有效 token
    vi.mocked(axios.post).mockResolvedValue({
      data: { accessToken: 'fake-access-token', expireIn: 3600 },
    })
    adapter = new DingTalkAdapter({ clientId: 'app1', clientSecret: 'secret1' })
  })

  afterEach(() => {
    if (originalTemplateId !== undefined) {
      process.env.DINGTALK_L3_CARD_TEMPLATE_ID = originalTemplateId
    } else {
      delete process.env.DINGTALK_L3_CARD_TEMPLATE_ID
    }
  })

  it('InteractiveCard → POST /v1.0/card/instances/createAndDeliver，cardParamMap 用 templateParams', async () => {
    process.env.DINGTALK_L3_CARD_TEMPLATE_ID = 'test-template.schema'

    await adapter.sendDirectMessage('user-42', {
      title: 'L3 修复方案审批',
      body: 'description text',
      actions: [
        { label: '同意', value: 'agree', style: 'primary' },
        { label: '拒绝', value: 'reject', style: 'danger' },
      ],
      callbackData: { taskId: 'l3-fix-120' },
      templateParams: {
        title: 'L3 修复方案审批',
        Issue_link: 'http://code.paraview.cn/...',
        remark: 'description text',
        created_at: '2026-04-21 12:00:00',
      },
    })

    // 第 1 次是 gettoken，第 2 次才是 createAndDeliver
    const calls = vi.mocked(axios.post).mock.calls
    const cardCall = calls.find(c => (c[0] as string).includes('/card/instances/createAndDeliver'))
    expect(cardCall).toBeTruthy()
    expect(cardCall![0]).toBe('https://api.dingtalk.com/v1.0/card/instances/createAndDeliver')
    expect(cardCall![1]).toMatchObject({
      userIdType: 1,
      outTrackId: 'l3-fix-120',
      cardTemplateId: 'test-template.schema',
      callbackType: 'STREAM',
      openSpaceId: 'dtv1.card//IM_ROBOT.user-42',
      imRobotOpenDeliverModel: {
        spaceType: 'IM_ROBOT',
        robotCode: 'app1',
      },
      cardData: {
        cardParamMap: {
          title: 'L3 修复方案审批',
          Issue_link: 'http://code.paraview.cn/...',
          remark: 'description text',
          created_at: '2026-04-21 12:00:00',
        },
      },
    })
  })

  it('未配 DINGTALK_L3_CARD_TEMPLATE_ID 时 InteractiveCard 降级为 sampleMarkdown 文字', async () => {
    delete process.env.DINGTALK_L3_CARD_TEMPLATE_ID

    await adapter.sendDirectMessage('user-42', {
      title: 'L3 修复方案审批',
      body: 'description',
      actions: [{ label: '同意', value: 'agree', style: 'primary' }],
      callbackData: { taskId: 'l3-fix-120' },
    })

    const calls = vi.mocked(axios.post).mock.calls
    // 不调 card/instances/createAndDeliver
    expect(calls.some(c => (c[0] as string).includes('/card/instances/createAndDeliver'))).toBe(false)
    // 改走 oToMessages/batchSend
    const textCall = calls.find(c => (c[0] as string).includes('/oToMessages/batchSend'))
    expect(textCall).toBeTruthy()
  })

  it('InteractiveCard 缺 callbackData.taskId 时抛错（不能没有 outTrackId）', async () => {
    process.env.DINGTALK_L3_CARD_TEMPLATE_ID = 'test-template.schema'

    await expect(adapter.sendDirectMessage('user-42', {
      title: 'x',
      body: 'y',
      actions: [{ label: 'ok', value: 'ok', style: 'primary' }],
      callbackData: {}, // 没 taskId
    })).rejects.toThrow(/taskId.*outTrackId/)
  })
})

describe('DingTalk card callback 解析（新旧格式兼容）', () => {
  let adapter: DingTalkAdapter

  beforeEach(() => {
    vi.mocked(axios.post).mockReset()
    vi.mocked(axios.post).mockResolvedValue({
      data: { accessToken: 'fake', expireIn: 3600 },
    })
    adapter = new DingTalkAdapter({ clientId: 'app1', clientSecret: 'secret1' })
  })

  function buildCallbackEvent(data: Record<string, unknown>) {
    return {
      specVersion: '1.0',
      type: 'CALLBACK',
      headers: {
        appId: 'app1',
        connectionId: 'c1',
        contentType: 'application/json',
        messageId: 'msg-xxx',
        time: '2026-04-21T12:00:00Z',
        topic: TOPIC_CARD,
      },
      data: JSON.stringify(data),
    }
  }

  it('新格式（钉钉 AI 卡片 2.0）：outTrackId + content.cardPrivateData.actionIds[0]=agree → handler 收到 agree', async () => {
    const handler = vi.fn()
    adapter.onCardAction(handler)

    mockClient._trigger(TOPIC_CARD, buildCallbackEvent({
      outTrackId: 'l3-fix-120',
      userId: 'u-primary',
      type: 'actionCallback',
      content: JSON.stringify({
        cardPrivateData: { actionIds: ['agree'], params: { action: 'agree' } },
      }),
    }))
    await Promise.resolve()

    expect(handler).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledWith('l3-fix-120', 'agree', 'u-primary')
  })

  it('新格式：actionIds[0]=reject → handler 收到 reject', async () => {
    const handler = vi.fn()
    adapter.onCardAction(handler)

    mockClient._trigger(TOPIC_CARD, buildCallbackEvent({
      outTrackId: 'l3-fix-121',
      userId: 'u-primary',
      type: 'actionCallback',
      content: JSON.stringify({
        cardPrivateData: { actionIds: ['reject'], params: { action: 'reject' } },
      }),
    }))
    await Promise.resolve()

    expect(handler).toHaveBeenCalledWith('l3-fix-121', 'reject', 'u-primary')
  })

  it('新格式：content 解析失败时仍回落到 params.action', async () => {
    const handler = vi.fn()
    adapter.onCardAction(handler)

    // actionIds 缺失，只有 params.action
    mockClient._trigger(TOPIC_CARD, buildCallbackEvent({
      outTrackId: 'l3-fix-122',
      userId: 'u-primary',
      content: JSON.stringify({
        cardPrivateData: { params: { action: 'agree' } },
      }),
    }))
    await Promise.resolve()

    expect(handler).toHaveBeenCalledWith('l3-fix-122', 'agree', 'u-primary')
  })

  it('旧格式：callbackData.{taskId,action} 仍兼容', async () => {
    const handler = vi.fn()
    adapter.onCardAction(handler)

    mockClient._trigger(TOPIC_CARD, buildCallbackEvent({
      callbackData: { taskId: 'task-42', action: 'approve' },
      userId: 'u-002',
    }))
    await Promise.resolve()

    expect(handler).toHaveBeenCalledWith('task-42', 'approve', 'u-002')
  })

  it('缺关键字段时 handler 不被调用，但仍 ACK', async () => {
    const handler = vi.fn()
    adapter.onCardAction(handler)

    mockClient._trigger(TOPIC_CARD, buildCallbackEvent({
      // 没 taskId / outTrackId，也没 action
      content: JSON.stringify({ cardPrivateData: {} }),
      userId: 'u-x',
    }))
    await Promise.resolve()

    expect(handler).not.toHaveBeenCalled()
    expect(mockClient.send).toHaveBeenCalledWith('msg-xxx', { status: 'SUCCESS' })
  })
})
