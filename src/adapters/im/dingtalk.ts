import axios from 'axios'
import { DWClient, DWClientDownStream, EventAck, TOPIC_ROBOT, TOPIC_CARD } from 'dingtalk-stream-sdk-nodejs'
import type {
  IMAdapter, MessageHandler, CardActionHandler,
  MessageTarget, TextContent, InteractiveCard, UserInfo, NormalizedMessage
} from './types.js'

interface DingTalkStreamConfig {
  clientId: string
  clientSecret: string
}

interface RobotMessage {
  conversationId: string
  chatbotUserId: string
  msgId: string
  senderNick: string
  isAdmin: boolean
  senderStaffId: string
  sessionWebhookExpiredTime: number
  createAt: number
  senderCorpId: string
  conversationType: string
  senderId: string
  sessionWebhook: string
  robotCode: string
  msgtype: string
  text: { content: string }
}

interface AccessTokenCache {
  token: string
  expiresAt: number
}

export class DingTalkAdapter implements IMAdapter {
  readonly platform = 'dingtalk' as const
  private messageHandler: MessageHandler | null = null
  private cardActionHandler: CardActionHandler | null = null

  // WebSocket client
  private readonly client: DWClient

  // Cache sessionWebhook by conversationId for group replies
  private readonly webhookCache = new Map<string, string>()

  // Dedup: track processed msgIds to prevent duplicate handling
  private readonly processedMsgIds = new Set<string>()

  // Access token cache for OpenAPI (DMs)
  private accessTokenCache: AccessTokenCache | null = null

  constructor(private readonly cfg: DingTalkStreamConfig) {
    this.client = new DWClient({
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      keepAlive: true,
    })

    // Log ALL events for debugging
    this.client.registerAllEventListener((res: DWClientDownStream) => {
      console.log('[DingTalk] Event received:', res.type, res.headers?.topic, res.headers?.messageId)
      return { status: EventAck.SUCCESS }
    })

    this.client
      .registerCallbackListener(TOPIC_ROBOT, (res: DWClientDownStream) => {
        console.log('[DingTalk] Robot message received:', res.headers.messageId)
        void this.handleRobotMessage(res)
      })
      .registerCallbackListener(TOPIC_CARD, (res: DWClientDownStream) => {
        console.log('[DingTalk] Card callback received:', res.headers.messageId)
        void this.handleCardCallback(res)
      })
  }

  onMessage(handler: MessageHandler): void { this.messageHandler = handler }
  onCardAction(handler: CardActionHandler): void { this.cardActionHandler = handler }

  async start(): Promise<void> {
    await this.client.connect()
  }

  async stop(): Promise<void> {
    this.client.disconnect()
  }

  // Stream mode does not use HTTP webhooks
  async handleWebhook(_payload: unknown, _headers: Record<string, string>): Promise<void> {
    throw new Error('DingTalk adapter is running in Stream mode — HTTP webhooks are not supported')
  }

  // ── Sending ──────────────────────────────────────────────────────────────

  async sendMessage(target: MessageTarget, content: TextContent): Promise<void> {
    const webhook = this.getWebhook(target)
    await axios.post(webhook, {
      msgtype: 'markdown',
      markdown: { title: 'ChatOps', text: content.text },
    })
  }

  async sendCard(target: MessageTarget, card: InteractiveCard): Promise<void> {
    const webhook = this.getWebhook(target)
    const markdown = this.cardToMarkdown(card)
    await axios.post(webhook, {
      msgtype: 'markdown',
      markdown: { title: card.title, text: markdown },
    })
  }

  async sendDirectMessage(userId: string, content: TextContent | InteractiveCard): Promise<void> {
    const token = await this.getAccessToken()
    const isCard = 'actions' in content
    const msgBody = isCard
      ? {
          msgtype: 'markdown',
          markdown: {
            title: (content as InteractiveCard).title,
            text: this.cardToMarkdown(content as InteractiveCard),
          },
        }
      : { msgtype: 'text', text: { content: (content as TextContent).text } }

    await axios.post(
      'https://oapi.dingtalk.com/topapi/message/corpconversation/asyncsend_v2',
      {
        agent_id: this.cfg.clientId,
        userid_list: userId,
        msg: msgBody,
      },
      { headers: { 'x-acs-dingtalk-access-token': token } }
    )
  }

  async getUserInfo(userId: string): Promise<UserInfo> {
    return { userId, name: userId, platform: 'dingtalk' }
  }

  // ── Internal handlers ────────────────────────────────────────────────────

  private async handleRobotMessage(res: DWClientDownStream): Promise<void> {
    let msg: RobotMessage
    try {
      msg = JSON.parse(res.data) as RobotMessage
    } catch (err) {
      console.error('[DingTalk] Failed to parse robot message:', err)
      return
    }

    // Dedup by msgId — DingTalk may redeliver the same message
    if (this.processedMsgIds.has(msg.msgId)) {
      console.log('[DingTalk] Duplicate msgId, skipping:', msg.msgId)
      this.client.send(res.headers.messageId, { status: 'SUCCESS' })
      return
    }
    this.processedMsgIds.add(msg.msgId)
    // Cleanup old msgIds (keep last 200)
    if (this.processedMsgIds.size > 200) {
      const first = this.processedMsgIds.values().next().value
      if (first) this.processedMsgIds.delete(first)
    }

    console.log('[DingTalk] Message from:', msg.senderNick, '| conversationId:', msg.conversationId, '| text:', msg.text?.content)

    // Cache sessionWebhook so we can reply to this conversation later
    if (msg.sessionWebhook) {
      this.webhookCache.set(msg.conversationId, msg.sessionWebhook)
    }

    // Strip @mentions from text
    const text = (msg.text?.content ?? '').replace(/@\S+/g, '').trim()

    // ACK immediately
    this.client.send(res.headers.messageId, { status: 'SUCCESS' })

    if (!text) {
      console.log('[DingTalk] Empty text after stripping mentions, skipping')
      return
    }

    console.log('[DingTalk] Processed text:', text, '| hasHandler:', !!this.messageHandler)

    const normalized: NormalizedMessage = {
      platform: 'dingtalk',
      groupId: msg.conversationId,
      userId: msg.senderId,
      userName: msg.senderNick,
      text,
      timestamp: msg.createAt ?? Date.now(),
      rawPayload: msg,
    }

    await this.messageHandler?.(normalized)
  }

  private async handleCardCallback(res: DWClientDownStream): Promise<void> {
    let data: Record<string, unknown>
    try {
      data = JSON.parse(res.data) as Record<string, unknown>
    } catch {
      this.client.send(res.headers.messageId, { status: 'SUCCESS' })
      return
    }

    // ACK
    this.client.send(res.headers.messageId, { status: 'SUCCESS' })

    const callbackData = (data.callbackData ?? data) as Record<string, string>
    const taskId = callbackData.taskId ?? (data.taskId as string)
    const action = callbackData.action ?? (data.action as string)
    const userId = (data.userId ?? data.operatorUserId) as string

    if (taskId && action && userId) {
      await this.cardActionHandler?.(taskId, action, userId)
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private getWebhook(target: MessageTarget): string {
    const hook = this.webhookCache.get(target.id)
    if (!hook) {
      throw new Error(`No sessionWebhook cached for conversation ${target.id}`)
    }
    return hook
  }

  private cardToMarkdown(card: InteractiveCard): string {
    const buttons = card.actions
      .map(a => `[${a.label}](callback://chatops?taskId=${card.callbackData.taskId}&action=${a.value})`)
      .join(' | ')
    return `${card.body}\n\n${buttons}`
  }

  private async getAccessToken(): Promise<string> {
    const now = Date.now()
    if (this.accessTokenCache && this.accessTokenCache.expiresAt > now + 60_000) {
      return this.accessTokenCache.token
    }

    const response = await axios.post<{ accessToken: string; expireIn: number }>(
      'https://api.dingtalk.com/v1.0/oauth2/accessToken',
      { appKey: this.cfg.clientId, appSecret: this.cfg.clientSecret }
    )

    const { accessToken, expireIn } = response.data
    this.accessTokenCache = {
      token: accessToken,
      expiresAt: now + expireIn * 1000,
    }
    return accessToken
  }
}
