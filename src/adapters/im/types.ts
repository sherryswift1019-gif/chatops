export interface MessageTarget {
  type: 'group' | 'user'
  id: string
}

export interface TextContent {
  text: string
}

export interface InteractiveCard {
  title: string
  body: string
  actions: CardAction[]
  callbackData: Record<string, string>
  /**
   * 可选：模板变量 map（用于钉钉 AI 卡片 / 互动卡片等带模板的场景）。
   * 不填则 adapter 用 { title, body } 作默认 cardParamMap。
   */
  templateParams?: Record<string, string>
}

export interface CardAction {
  label: string
  value: string
  style: 'primary' | 'danger' | 'default'
}

export interface UserInfo {
  userId: string
  name: string
  platform: 'dingtalk' | 'feishu'
}

export interface NormalizedMessage {
  platform: 'dingtalk' | 'feishu'
  groupId: string
  userId: string
  userName: string
  text: string
  images?: string[]  // 图片本地文件路径（钉钉图片下载后）
  repliedText?: string  // 引用回复的文本内容
  timestamp: number
  rawPayload: unknown
}

export type MessageHandler = (msg: NormalizedMessage) => void | Promise<void>
export type CardActionHandler = (taskId: string, action: string, approverId: string) => void | Promise<void>

export interface IMAdapter {
  readonly platform: 'dingtalk' | 'feishu'
  onMessage(handler: MessageHandler): void
  sendMessage(target: MessageTarget, content: TextContent): Promise<void>
  sendCard(target: MessageTarget, card: InteractiveCard): Promise<void>
  sendDirectMessage(userId: string, content: TextContent | InteractiveCard): Promise<void>
  getUserInfo(userId: string): Promise<UserInfo>
  onCardAction(handler: CardActionHandler): void
  handleWebhook(payload: unknown, headers: Record<string, string>): Promise<void>
  start?(): Promise<void>
  stop?(): Promise<void>
}
