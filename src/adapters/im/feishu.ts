import axios from 'axios'
import type {
  IMAdapter, MessageHandler, CardActionHandler,
  MessageTarget, TextContent, InteractiveCard, UserInfo, NormalizedMessage
} from './types.js'

interface FeishuConfig {
  appId: string
  appSecret: string
  verificationToken: string
}

export class FeishuAdapter implements IMAdapter {
  readonly platform = 'feishu' as const
  private messageHandler: MessageHandler | null = null
  private cardActionHandler: CardActionHandler | null = null
  private tenantToken: string | null = null
  private tokenExpiry = 0

  constructor(private readonly cfg: FeishuConfig) {}

  onMessage(handler: MessageHandler): void { this.messageHandler = handler }
  onCardAction(handler: CardActionHandler): void { this.cardActionHandler = handler }

  async handleWebhook(payload: unknown, _headers: Record<string, string>): Promise<void> {
    const body = payload as Record<string, unknown>

    // URL verification handshake
    if (body.type === 'url_verification') return

    // Card action
    if ((body.header as Record<string, string>)?.event_type === 'card.action.trigger') {
      const event = body.event as Record<string, unknown>
      const data = event.action as Record<string, unknown>
      await this.cardActionHandler?.(
        (data.value as Record<string, string>).taskId,
        (data.value as Record<string, string>).action,
        (event.operator as Record<string, string>).union_id
      )
      return
    }

    // Message event
    const event = body.event as Record<string, unknown>
    const message = event?.message as Record<string, unknown>
    if (!message) return

    const content = JSON.parse(message.content as string)
    const rawText: string = content.text ?? ''
    const text = rawText.replace(/@\S+/g, '').trim()
    if (!text) return

    const sender = event.sender as Record<string, Record<string, string>>
    const msg: NormalizedMessage = {
      platform: 'feishu',
      groupId: message.chat_id as string,
      userId: sender.sender_id.union_id,
      userName: sender.sender_id.union_id,
      text,
      timestamp: Date.now(),
      rawPayload: payload,
    }
    await this.messageHandler?.(msg)
  }

  async sendMessage(target: MessageTarget, content: TextContent): Promise<void> {
    await this.postMessage(target.id, 'text', JSON.stringify({ text: content.text }))
  }

  async sendCard(target: MessageTarget, card: InteractiveCard): Promise<void> {
    const cardContent = this.buildCard(card)
    await this.postMessage(target.id, 'interactive', cardContent)
  }

  async sendDirectMessage(userId: string, content: TextContent | InteractiveCard): Promise<void> {
    const isCard = 'actions' in content
    if (isCard) {
      const cardContent = this.buildCard(content as InteractiveCard)
      await this.postMessageToUser(userId, 'interactive', cardContent)
    } else {
      await this.postMessageToUser(userId, 'text', JSON.stringify({ text: (content as TextContent).text }))
    }
  }

  async getUserInfo(userId: string): Promise<UserInfo> {
    return { userId, name: userId, platform: 'feishu' }
  }

  private async getTenantToken(): Promise<string> {
    if (this.tenantToken && Date.now() < this.tokenExpiry) return this.tenantToken
    const res = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      app_id: this.cfg.appId, app_secret: this.cfg.appSecret
    })
    this.tenantToken = res.data.tenant_access_token
    this.tokenExpiry = Date.now() + (res.data.expire - 60) * 1000
    return this.tenantToken!
  }

  private async postMessage(chatId: string, msgType: string, content: string): Promise<void> {
    const token = await this.getTenantToken()
    await axios.post('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
      receive_id: chatId, msg_type: msgType, content
    }, { headers: { Authorization: `Bearer ${token}` } })
  }

  private async postMessageToUser(userId: string, msgType: string, content: string): Promise<void> {
    const token = await this.getTenantToken()
    await axios.post('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=union_id', {
      receive_id: userId, msg_type: msgType, content
    }, { headers: { Authorization: `Bearer ${token}` } })
  }

  private buildCard(card: InteractiveCard): string {
    return JSON.stringify({
      config: { wide_screen_mode: true },
      elements: [
        { tag: 'div', text: { content: card.body, tag: 'lark_md' } },
        {
          tag: 'action',
          actions: card.actions.map(a => ({
            tag: 'button',
            text: { content: a.label, tag: 'plain_text' },
            type: a.style === 'danger' ? 'danger' : 'primary',
            value: { ...card.callbackData, action: a.value },
          })),
        },
      ],
      header: { title: { content: card.title, tag: 'plain_text' } },
    })
  }
}
