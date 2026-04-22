import axios from 'axios'
import { DWClient, DWClientDownStream, EventAck, TOPIC_ROBOT, TOPIC_CARD } from 'dingtalk-stream-sdk-nodejs'
import type {
  IMAdapter, MessageHandler, CardActionHandler,
  MessageTarget, TextContent, InteractiveCard, UserInfo, NormalizedMessage
} from './types.js'
import { getConfig } from '../../db/repositories/system-config.js'

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
    // 互动卡片分支：走 /v1.0/im/interactiveCards/send
    if ('actions' in content) {
      return this.sendInteractiveCard(userId, content as InteractiveCard)
    }
    const token = await this.getAccessToken()
    const text = (content as TextContent).text

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

  /**
   * 发送钉钉互动卡片（基于已在钉钉 OA 后台创建的 cardTemplateId）。
   *
   * 模板 ID 来源：`system_config.dingtalk.cardTemplates.issue_approval`。
   * 管理员可在 Admin UI → 系统配置 → 钉钉 tab → "互动卡片模板" 里维护。
   * 未配置时直接抛错（不降级为文字、不读 env fallback）——让调用方感知问题。
   * 用卡片 2.0 API：`/v1.0/card/instances/createAndDeliver`（需权限 `Card.Instance.Write`）。
   * outTrackId 用 content.callbackData.taskId（保证同一 approval 幂等 + 回调能映射回）。
   * openSpaceId 用 `dtv1.card//IM_ROBOT.<userId>` 维度投放到机器人 1v1 会话。
   * cardParamMap 优先用 content.templateParams；未提供则用默认 { title, body }。
   */
  private async sendInteractiveCard(userId: string, card: InteractiveCard): Promise<void> {
    const dingCfg = (await getConfig('dingtalk'))?.value as
      | { cardTemplates?: Record<string, string> }
      | undefined
    const templateId = dingCfg?.cardTemplates?.issue_approval
    if (!templateId || templateId.trim().length === 0) {
      throw new Error(
        '[DingTalk] issue_approval 卡片模板未配置。请到 Admin UI → 系统配置 → 钉钉 tab → "互动卡片模板" 中添加 issue_approval = <模板 ID>（钉钉 OA 开发者平台创建）',
      )
    }
    const outTrackId = card.callbackData.taskId
    if (!outTrackId) {
      throw new Error('[DingTalk] InteractiveCard.callbackData.taskId is required (used as outTrackId)')
    }
    // 钉钉互动卡片模板 cc60e23f-...053a.schema 的变量（2026-04-22 实测对齐）:
    //   title / body (富文本 markdown) / createTime / status
    //
    // approval-manager.ts 硬约束不改，它固定吐 title='🔐 流水线审批' + body='**操作：** <desc>'，
    // 在 adapter 层按 title 识别并做 UX 调整：
    //   - 标题替换为"Issue 修复方案审批"
    //   - body 脱掉 "**操作：** " 前缀（resolver 给的 description 已是结构化 markdown）
    const PIPELINE_APPROVAL_TITLE_RAW = '🔐 流水线审批'
    const OPERATION_PREFIX = '**操作：** '
    const displayTitle =
      card.title === PIPELINE_APPROVAL_TITLE_RAW ? 'Bug 修复方案审批' : card.title
    const rawBody = card.body ?? ''
    const displayBody = rawBody.startsWith(OPERATION_PREFIX)
      ? rawBody.slice(OPERATION_PREFIX.length)
      : rawBody
    const cardParamMap: Record<string, string> = card.templateParams ?? (() => {
      const d = new Date()
      const pad = (n: number) => String(n).padStart(2, '0')
      const now = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
      return {
        title: displayTitle,
        body: displayBody,
        createTime: now,
        status: 'pending',
      }
    })()
    console.log('[DingTalk] cardParamMap:', JSON.stringify(cardParamMap))
    const token = await this.getAccessToken()
    await axios.post(
      'https://api.dingtalk.com/v1.0/card/instances/createAndDeliver',
      {
        userIdType: 1, // 1=企业 userId（默认）；2=unionId
        cardTemplateId: templateId,
        outTrackId,
        callbackType: 'STREAM', // 按钮点击通过 Stream 回传（复用现有 WSS 通道）
        cardData: { cardParamMap },
        openSpaceId: `dtv1.card//IM_ROBOT.${userId}`,
        imRobotOpenSpaceModel: {
          lastMessageI18n: { ZH_CN: card.title },
          supportForward: false,
        },
        imRobotOpenDeliverModel: {
          spaceType: 'IM_ROBOT',
          robotCode: this.cfg.clientId,
        },
      },
      { headers: { 'x-acs-dingtalk-access-token': token } }
    )
    console.log(`[DingTalk] InteractiveCard sent to ${userId}, outTrackId=${outTrackId}`)
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

    console.log('[DingTalk] Message from:', msg.senderNick, '| staffId:', msg.senderStaffId, '| conversationId:', msg.conversationId, '| msgtype:', msg.msgtype)

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

    // 钉钉 AI 卡片 2.0 回传实测格式（/v1.0/card/instances/callback）：
    //   {
    //     outTrackId: "...",                                 ← top-level
    //     userId: "...",                                     ← top-level
    //     type: "actionCallback",
    //     content: "{\"cardPrivateData\":{\"actionIds\":[\"agree\"],\"params\":{\"action\":\"agree\"}}}"
    //           ↑ 双层 JSON：content 本身是字符串，parse 后 cardPrivateData.actionIds[0] 是按钮 Action ID
    //   }
    //
    // 兼容旧互动卡片格式：callbackData.{taskId, action} 仍解析。

    const taskId =
      (data.outTrackId as string) ??
      ((data.callbackData as Record<string, string> | undefined)?.taskId) ??
      ((data.callbackData as Record<string, string> | undefined)?.outTrackId)

    const userId = (data.userId ?? data.operatorUserId) as string

    // 解析 action：先试新版 content JSON，再 fallback 旧 callbackData
    let action: string | undefined
    if (typeof data.content === 'string') {
      try {
        const content = JSON.parse(data.content) as {
          cardPrivateData?: { actionIds?: string[]; params?: Record<string, string> }
        }
        action = content.cardPrivateData?.actionIds?.[0] ?? content.cardPrivateData?.params?.action
      } catch {
        /* content 不是合法 JSON，忽略 */
      }
    }
    if (!action) {
      const cb = (data.callbackData ?? {}) as Record<string, unknown>
      const actionObj = (data.action ?? cb.action) as unknown
      action =
        (typeof actionObj === 'object' && actionObj !== null
          ? (actionObj as Record<string, string>).id ??
            (actionObj as Record<string, string>).key ??
            (actionObj as Record<string, string>).value
          : (actionObj as string)) ??
        (cb.actionId as string) ??
        (cb.actionKey as string)
    }

    if (taskId && action && userId) {
      // 钉钉模板按钮 value 是 agree/reject，chatops 内部常量是 approved/rejected
      // adapter 做映射屏蔽差异，保持 approval-manager.ts 硬约束不改
      const normalizedAction =
        action === 'agree' ? 'approved' :
        action === 'reject' ? 'rejected' :
        action
      console.log(`[DingTalk] Card callback parsed OK: outTrackId=${taskId} action=${action}→${normalizedAction} userId=${userId}`)
      await this.cardActionHandler?.(taskId, normalizedAction, userId)
      // 审批类 action：更新卡片 status 变量，触发模板侧按钮禁用态切换
      if (normalizedAction === 'approved' || normalizedAction === 'rejected') {
        try {
          await this.updateInteractiveCard(taskId, normalizedAction)
        } catch (err) {
          console.warn('[DingTalk] updateInteractiveCard failed (非阻塞):', err)
        }
      }
    } else {
      console.warn('[DingTalk] handleCardCallback: missing fields', {
        taskId: !!taskId,
        action: !!action,
        userId: !!userId,
      })
    }
  }

  /**
   * 审批决议后原地更新卡片的 status 变量。
   *
   * 依赖模板侧按 status 配置的按钮显示条件：
   *   status=pending → 显示"拒绝/同意"可点按钮
   *   status=agree   → 显示"已同意"灰色禁用按钮
   *   status=reject  → 显示"已拒绝"灰色禁用按钮
   *
   * chatops 内部常量 APPROVAL_APPROVED=approved / APPROVAL_REJECTED=rejected，
   * 钉钉模板里用的是 agree/reject —— adapter 层做一次映射屏蔽差异。
   *
   * 钉钉更新卡片 API：PUT /v1.0/card/instances
   * cardUpdateOptions.updateCardDataByKey=true：只合并传入的 key，不覆盖其他字段
   */
  private async updateInteractiveCard(
    outTrackId: string,
    action: 'approved' | 'rejected',
  ): Promise<void> {
    const status = action === 'approved' ? 'agree' : 'reject'
    const token = await this.getAccessToken()
    await axios.put(
      'https://api.dingtalk.com/v1.0/card/instances',
      {
        outTrackId,
        cardData: { cardParamMap: { status } },
        cardUpdateOptions: { updateCardDataByKey: true },
        userIdType: 1,
      },
      { headers: { 'x-acs-dingtalk-access-token': token } },
    )
    console.log(`[DingTalk] card status updated: outTrackId=${outTrackId} action=${action} → status=${status}`)
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
