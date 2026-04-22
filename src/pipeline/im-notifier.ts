/**
 * im-notifier — 让 pipeline 的节点/runner 可以向 IM 群发送消息。
 *
 * IM adapters（dingtalk/feishu）启动时调 registerImSender 注入发送函数。
 * 若某平台未注册，notifyImGroup 仅打 log，不抛错（避免阻断流程）。
 */

type SendFn = (groupId: string, text: string) => Promise<void>

const senders = new Map<string, SendFn>()

export function registerImSender(platform: string, fn: SendFn): void {
  senders.set(platform, fn)
}

export function hasImSender(platform: string): boolean {
  return senders.has(platform)
}

export async function notifyImGroup(platform: string, groupId: string, text: string): Promise<void> {
  const fn = senders.get(platform)
  if (!fn) {
    console.warn(`[im-notifier] no sender registered for platform="${platform}"`)
    return
  }
  try {
    await fn(groupId, text)
  } catch (err) {
    console.error(`[im-notifier] send failed platform=${platform} group=${groupId}:`, err)
  }
}

/** 测试用：清空所有已注册 sender。 */
export function __clearImSendersForTest(): void {
  senders.clear()
}
