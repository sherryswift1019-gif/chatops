import { vi } from 'vitest'
import type { IMAdapter, MessageHandler, CardActionHandler, NormalizedMessage } from '../../adapters/im/types.js'

export function createMockAdapter(platform: 'dingtalk' | 'feishu' = 'dingtalk'): IMAdapter & {
  simulateMessage(msg: Partial<NormalizedMessage>): void
  simulateCardAction(taskId: string, action: string, approverId: string): void
  sentMessages: Array<{ target: unknown; content: unknown }>
  sentDMs: Array<{ userId: string; content: unknown }>
} {
  let messageHandler: MessageHandler | null = null
  let cardActionHandler: CardActionHandler | null = null
  const sentMessages: Array<{ target: unknown; content: unknown }> = []
  const sentDMs: Array<{ userId: string; content: unknown }> = []

  return {
    platform,
    onMessage: (h) => { messageHandler = h },
    onCardAction: (h) => { cardActionHandler = h },
    sendMessage: vi.fn(async (target, content) => { sentMessages.push({ target, content }) }),
    sendCard: vi.fn(async (target, card) => { sentMessages.push({ target, content: card }) }),
    sendDirectMessage: vi.fn(async (userId, content) => { sentDMs.push({ userId, content }) }),
    getUserInfo: vi.fn(async (userId) => ({ userId, name: `User-${userId}`, platform })),
    handleWebhook: vi.fn(async () => {}),
    simulateMessage(partial) {
      const msg: NormalizedMessage = {
        platform, groupId: 'g1', userId: 'u1', userName: 'Test',
        text: 'hello', timestamp: Date.now(),
        rawPayload: {}, ...partial
      }
      messageHandler?.(msg)
    },
    simulateCardAction(taskId, action, approverId) {
      cardActionHandler?.(taskId, action, approverId)
    },
    sentMessages,
    sentDMs,
  }
}
