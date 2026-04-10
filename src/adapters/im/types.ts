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
}
