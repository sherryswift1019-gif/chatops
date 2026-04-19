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

interface RichTextItem {
  text?: string
  content?: string
  type?: string        // 当前消息 richText: 'picture' | 'text'
  msgType?: string     // 引用消息 richText: 'picture' | 'text'
  downloadCode?: string
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
  text: {
    content: string
    // 引用回复嵌套在 text 里
    repliedMsg?: {
      msgType?: string
      content?: {
        richText?: RichTextItem[]
        downloadCode?: string
        photoURL?: string
      } | string
    }
  }
  // richText 图文混排（顶层 content.richText）
  content?: {
    richText?: RichTextItem[]
    photoURL?: string
    downloadCode?: string
  } | string
  // imageList 数组形式
  imageList?: Array<{ downloadCode?: string; imageUrl?: string }>
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

  // Connection status tracking
  private startedAt: number | null = null
  private lastEventAt: number | null = null
  private startError: string | null = null

  constructor(private readonly cfg: DingTalkStreamConfig) {
    this.client = new DWClient({
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      keepAlive: true,
    })

    // Log ALL events for debugging
    this.client.registerAllEventListener((res: DWClientDownStream) => {
      this.lastEventAt = Date.now()
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
    // Reset per-session state so a restart never inherits heartbeats or errors
    // from a previous run.
    this.lastEventAt = null
    this.startError = null
    try {
      await this.client.connect()
      this.startedAt = Date.now()
    } catch (err) {
      this.startError = err instanceof Error ? err.message : String(err)
      this.startedAt = null
      throw err
    }
  }

  async stop(): Promise<void> {
    this.client.disconnect()
    this.startedAt = null
    this.lastEventAt = null
  }

  getConnectionStatus(): {
    configured: boolean
    started: boolean
    startedAt: number | null
    lastEventAt: number | null
    startError: string | null
    connected: boolean
  } {
    const started = this.startedAt !== null
    // SDK 的 keepAlive 是 WebSocket 原生 ping/pong，不经过 registerAllEventListener，
    // 因此不能用 lastEventAt 推断连接健康。改用 SDK 暴露的 public 字段：
    // socket 打开 (connected) + 已完成 DingTalk 服务端注册握手 (registered)。
    const connected = started && this.client.connected && this.client.registered
    return {
      configured: true,
      started,
      startedAt: this.startedAt,
      lastEventAt: this.lastEventAt,
      startError: this.startError,
      connected,
    }
  }

  credentialsMatch(clientId: string, clientSecret: string): boolean {
    return this.cfg.clientId === clientId && this.cfg.clientSecret === clientSecret
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

    console.log('[DingTalk] Message from:', msg.senderNick, '| conversationId:', msg.conversationId, '| msgtype:', msg.msgtype)

    // Cache sessionWebhook so we can reply to this conversation later
    if (msg.sessionWebhook) {
      this.webhookCache.set(msg.conversationId, msg.sessionWebhook)
    }

    // ── 提取文本 ──────────────────────────────────────────
    let text = ''
    const contentObj = typeof msg.content === 'string' ? (() => { try { return JSON.parse(msg.content) } catch { return null } })() : msg.content

    if (msg.msgtype === 'richText' && contentObj?.richText) {
      // richText 图文混排：从 content.richText[] 提取文本
      text = contentObj.richText
        .filter((item: RichTextItem) => item.text || (item.type === 'text' && item.content))
        .map((item: RichTextItem) => item.text || item.content || '')
        .join('')
        .replace(/@\S+/g, '').trim()
    } else {
      text = (msg.text?.content ?? '').replace(/@\S+/g, '').trim()
    }

    // ── 提取图片 ──────────────────────────────────────────
    const images: string[] = []

    // 1. 引用回复中的图片（优先级最高，因为用户明确引用了某条消息）
    const repliedMsg = msg.text?.repliedMsg
    if (repliedMsg) {
      const repliedContent = typeof repliedMsg.content === 'string'
        ? (() => { try { return JSON.parse(repliedMsg.content) } catch { return null } })()
        : repliedMsg.content

      // 引用消息中的 richText 图片
      if (repliedContent?.richText) {
        for (const item of repliedContent.richText) {
          if (item.msgType === 'picture' && item.downloadCode) {
            images.push(item.downloadCode)
          }
          // 同时提取引用消息的文本
          if (item.msgType === 'text' && item.content) {
            const cleanText = item.content.replace(/@\S+\s*/g, '').trim()
            if (cleanText) text = cleanText + '\n' + text
          }
        }
      }

      // 引用消息是纯图片
      if (repliedMsg.msgType === 'picture' && repliedContent?.downloadCode) {
        images.push(repliedContent.downloadCode)
      }
    }

    // 2. 当前消息的 richText 图片
    if (contentObj?.richText) {
      for (const item of contentObj.richText) {
        if (item.type === 'picture' && item.downloadCode) {
          images.push(item.downloadCode)
        }
      }
    }

    // 3. 纯图片消息 (content.photoURL)
    if (contentObj?.photoURL) {
      images.push(contentObj.photoURL)
    }

    // 4. imageList 数组形式
    if (msg.imageList && msg.imageList.length > 0) {
      for (const img of msg.imageList) {
        const code = img.downloadCode || img.imageUrl
        if (code) images.push(code)
      }
    }

    // ── 提取引用文本 ──────────────────────────────────────
    let repliedText: string | undefined
    if (repliedMsg) {
      const repliedContent = typeof repliedMsg.content === 'string'
        ? (() => { try { return JSON.parse(repliedMsg.content) } catch { return null } })()
        : repliedMsg.content
      if (repliedContent?.richText) {
        repliedText = repliedContent.richText
          .filter((item: RichTextItem) => item.msgType === 'text' && item.content)
          .map((item: RichTextItem) => item.content)
          .join(' ')
      }
    }

    // ACK immediately
    this.client.send(res.headers.messageId, { status: 'SUCCESS' })

    if (!text && images.length === 0) {
      console.log('[DingTalk] Empty text and no images after stripping mentions, skipping')
      return
    }

    console.log('[DingTalk] Processed text:', text, '| images:', images.length, '| repliedText:', !!repliedText)

    const normalized: NormalizedMessage = {
      platform: 'dingtalk',
      groupId: msg.conversationId,
      userId: msg.senderStaffId,
      userName: msg.senderNick,
      text: text || '[图片]',
      images: images.length > 0 ? images : undefined,
      repliedText,
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
