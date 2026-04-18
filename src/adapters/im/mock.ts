/**
 * Mock IM adapter — 仅在 E2E_MODE=1 时由 server.ts 装载（替代 DingTalkAdapter）。
 *
 * 所有 send 系方法都只把消息写入 e2e-store 的 sentMessages，不做任何实际网络 IO。
 *
 * 入站消息：
 *   onMessage(handler) 会保存 handler，e2e 场景下通过 simulateIncomingMessage()
 *   主动触发（模拟群消息从钉钉 Stream 回调进来）。未保存 handler 时返回 false。
 *
 * platform 声明为 'dingtalk'，让上游业务以为自己接的是钉钉（审批路由、用户查询等
 * 按钉钉分支走），避免引入新 platform 值导致分支爆炸。
 */
import type {
  IMAdapter,
  MessageHandler,
  CardActionHandler,
  MessageTarget,
  TextContent,
  InteractiveCard,
  UserInfo,
  NormalizedMessage,
} from './types.js'
import { recordSentMessage } from '../../agent/mocks/e2e-store.js'

// 单例持有，供 _e2e 路由拿到当前进程里注册的 Mock adapter 实例
let currentInstance: MockIMAdapter | null = null

export function getMockIMAdapter(): MockIMAdapter | null {
  return currentInstance
}

export class MockIMAdapter implements IMAdapter {
  readonly platform = 'dingtalk' as const
  private messageHandler: MessageHandler | null = null

  constructor() {
    currentInstance = this
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler
  }

  onCardAction(_handler: CardActionHandler): void {
    // e2e 场景下不需要卡片回调
  }

  /**
   * 模拟一条入站消息，触发已注册的 messageHandler（如果有）。
   * 返回 true 表示 handler 已被调用。
   *
   * 用于 e2e 模拟"用户在群里发消息"，配合 _e2e/im/incoming 端点使用。
   */
  async simulateIncomingMessage(msg: NormalizedMessage): Promise<boolean> {
    if (!this.messageHandler) return false
    await this.messageHandler(msg)
    return true
  }

  async sendMessage(target: MessageTarget, content: TextContent): Promise<void> {
    recordSentMessage({
      kind: target.type === 'group' ? 'group' : 'direct',
      to: target.id,
      text: content.text,
    })
  }

  async sendCard(target: MessageTarget, card: InteractiveCard): Promise<void> {
    recordSentMessage({
      kind: 'card',
      to: target.id,
      card,
    })
  }

  async sendDirectMessage(userId: string, content: TextContent | InteractiveCard): Promise<void> {
    if ('text' in content) {
      recordSentMessage({ kind: 'direct', to: userId, text: content.text })
    } else {
      recordSentMessage({ kind: 'direct', to: userId, card: content })
    }
  }

  async getUserInfo(userId: string): Promise<UserInfo> {
    return { userId, name: userId, platform: 'dingtalk' }
  }

  async handleWebhook(_payload: unknown, _headers: Record<string, string>): Promise<void> {
    // noop
  }

  async start(): Promise<void> {
    // noop
  }

  async stop(): Promise<void> {
    // noop
  }
}
