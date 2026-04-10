import crypto from 'crypto'
import axios from 'axios'
import type {
  IMAdapter, MessageHandler, CardActionHandler,
  MessageTarget, TextContent, InteractiveCard, UserInfo, NormalizedMessage
} from './types.js'

interface DingTalkConfig {
  appSecret: string
  accessToken: string
}

export class DingTalkAdapter implements IMAdapter {
  readonly platform = 'dingtalk' as const
  private messageHandler: MessageHandler | null = null
  private cardActionHandler: CardActionHandler | null = null

  constructor(private readonly cfg: DingTalkConfig) {}

  onMessage(handler: MessageHandler): void { this.messageHandler = handler }
  onCardAction(handler: CardActionHandler): void { this.cardActionHandler = handler }

  async handleWebhook(payload: unknown, headers: Record<string, string>): Promise<void> {
    const ts = headers['x-dingtalk-timestamp'] ?? ''
    const sign = headers['x-dingtalk-sign'] ?? ''
    this.verifySignature(ts, sign)

    const body = payload as Record<string, unknown>

    // Card action callback
    if (body.actionType === 'card_action') {
      const data = body.callbackData as Record<string, string>
      await this.cardActionHandler?.(data.taskId, data.action, body.userId as string)
      return
    }

    // Text message
    const rawText = (body.text as { content?: string })?.content ?? ''
    const text = rawText.replace(/@\S+/g, '').trim()
    if (!text) return

    const msg: NormalizedMessage = {
      platform: 'dingtalk',
      groupId: body.conversationId as string,
      userId: body.senderId as string,
      userName: body.senderNick as string,
      text,
      timestamp: Date.now(),
      rawPayload: payload,
    }
    await this.messageHandler?.(msg)
  }

  async sendMessage(target: MessageTarget, content: TextContent): Promise<void> {
    await this.post({ msgtype: 'text', text: { content: content.text } })
  }

  async sendCard(_target: MessageTarget, card: InteractiveCard): Promise<void> {
    const markdown = this.cardToMarkdown(card)
    await this.post({ msgtype: 'markdown', markdown: { title: card.title, text: markdown } })
  }

  async sendDirectMessage(userId: string, content: TextContent | InteractiveCard): Promise<void> {
    const isCard = 'actions' in content
    const body = isCard
      ? { msgtype: 'markdown', markdown: { title: (content as InteractiveCard).title, text: this.cardToMarkdown(content as InteractiveCard) } }
      : { msgtype: 'text', text: { content: (content as TextContent).text } }
    await this.post({ ...body, toUserIds: [userId] })
  }

  async getUserInfo(userId: string): Promise<UserInfo> {
    return { userId, name: userId, platform: 'dingtalk' }
  }

  private verifySignature(timestamp: string, sign: string): void {
    const msg = `${timestamp}\n${this.cfg.appSecret}`
    const expected = encodeURIComponent(
      crypto.createHmac('sha256', this.cfg.appSecret).update(msg).digest('base64')
    )
    if (expected !== sign) throw new Error('Invalid signature')
  }

  private async post(body: unknown): Promise<void> {
    await axios.post(
      `https://oapi.dingtalk.com/robot/send?access_token=${this.cfg.accessToken}`,
      body
    )
  }

  private cardToMarkdown(card: InteractiveCard): string {
    const buttons = card.actions
      .map(a => `[${a.label}](callback://chatops?taskId=${card.callbackData.taskId}&action=${a.value})`)
      .join(' | ')
    return `${card.body}\n\n${buttons}`
  }
}
