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
        text?: string  // 纯文本引用时的字段
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
    // 因此不能用 lastEventAt 推断连接健康。改用 SDK 在 socket open/close 上维护的
    // this.client.connected 作为真相。
    // 注：SDK 还有一个 this.client.registered 字段，期望通过 SYSTEM.REGISTERED 握手置 true，
    // 但钉钉当前服务端协议已不再主动下发该消息（实测 socket open 后 15+ 分钟内无任何
    // SYSTEM 消息到达，而 CALLBACK 业务消息正常），registered 实际永远保持 false，
    // 因此不能依赖它。
    const connected = started && this.client.connected
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

  async sendMessage(target: MessageTarget, content: TextContent & { atDingtalkIds?: string[] }): Promise<void> {
    const webhook = this.getWebhook(target)
    if (content.atDingtalkIds && content.atDingtalkIds.length > 0) {
      // sessionWebhook + text + at.atDingtalkIds = 蓝色 @ 效果
      await axios.post(webhook, {
        msgtype: 'text',
        text: { content: content.text },
        at: { atDingtalkIds: content.atDingtalkIds, isAtAll: false },
      })
    } else {
      await axios.post(webhook, {
        msgtype: 'markdown',
        markdown: { title: 'ChatOps', text: content.text },
      })
    }
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
    const text = 'actions' in content
      ? `${(content as InteractiveCard).title}\n\n${(content as InteractiveCard).body}`
      : (content as TextContent).text

    await axios.post(
      'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend',
      {
        robotCode: this.cfg.clientId,
        userIds: [userId],
        msgKey: 'sampleMarkdown',
        msgParam: JSON.stringify({ title: 'ChatOps 通知', text }),
      },
      { headers: { 'x-acs-dingtalk-access-token': token } }
    )
    console.log(`[DingTalk] DM sent to ${userId}`)
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

    console.log('[DingTalk] 原始消息:', JSON.stringify(msg, null, 2))

    // Cache sessionWebhook so we can reply to this conversation later
    if (msg.sessionWebhook) {
      this.webhookCache.set(msg.conversationId, msg.sessionWebhook)
    }

    // ── @ mention 过滤：精确删除 @机器人名（从 conversationTitle 无法拿到，用 robotCode 查不到名字）
    // 方案：从 atUsers 里找到 chatbotUserId 对应的条目，然后在文本里匹配 @+任意字符直到下一个空格
    // 但钉钉可能不在 @ 后面加空格。最终方案：不删 @，直接传给 Claude，在 Step 0 里用前几个词提取 project/branch
    let text = ''
    const contentObj = typeof msg.content === 'string' ? (() => { try { return JSON.parse(msg.content) } catch { return null } })() : msg.content

    if (msg.msgtype === 'richText' && contentObj?.richText) {
      text = contentObj.richText
        .filter((item: RichTextItem) => item.text || (item.type === 'text' && item.content))
        .map((item: RichTextItem) => item.text || item.content || '')
        .join('')
        .trim()
    } else {
      text = (msg.text?.content ?? '').trim()
    }

    // 钉钉引用回复消息场景：
    // - 图文混排（文字+图片）：msgtype=text + repliedMsg.content.richText 数组
    // - 纯文本引用回复：msgtype=text + repliedMsg.content.text 字符串（新增覆盖）
    // 当 text.content 为空但有 repliedMsg 时，从引用内容提取用户的完整消息
    const repliedMsg = msg.text?.repliedMsg
    if (!text && repliedMsg) {
      const repliedContent = typeof repliedMsg.content === 'string'
        ? (() => { try { return JSON.parse(repliedMsg.content) } catch { return null } })()
        : repliedMsg.content

      if (repliedContent?.richText) {
        text = repliedContent.richText
          .filter((item: RichTextItem) => (item.msgType === 'text' || item.type === 'text') && item.content)
          .map((item: RichTextItem) => item.content || '')
          .join('\n')
          .trim()
      } else if (typeof repliedContent?.text === 'string') {
        // 纯文本引用（钉钉 msgType='text' 时 content.text 是字符串）
        text = repliedContent.text.trim()
      }
    }

    // ── 提取图片 ──────────────────────────────────────────
    const images: string[] = []

    // 1. repliedMsg 中的图片（图文混排或引用回复）
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
