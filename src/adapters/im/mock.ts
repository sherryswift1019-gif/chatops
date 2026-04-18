/**
 * Mock IM adapter — 仅在 E2E_MODE=1 时由 server.ts 装载（替代 DingTalkAdapter）。
 *
 * 所有 send 系方法都只把消息写入 e2e-store 的 sentMessages，不做任何实际网络 IO。
 * 其他生命周期方法（start/stop/onMessage/onCardAction/handleWebhook）留空——
 * e2e 场景下消息注入走 /admin/_e2e/... 端点或直接用 API 触发 pipeline，
 * 不从 IM 入口进。
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
} from './types.js'
import { recordSentMessage } from '../../agent/mocks/e2e-store.js'

export class MockIMAdapter implements IMAdapter {
  readonly platform = 'dingtalk' as const

  onMessage(_handler: MessageHandler): void {
    // 无需实际订阅：e2e 场景下消息注入不走 IM 链路
  }

  onCardAction(_handler: CardActionHandler): void {
    // 同上
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
