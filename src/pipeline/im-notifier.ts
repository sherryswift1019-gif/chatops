/**
 * im-notifier — 让 pipeline 的节点/runner 可以向 IM 群发送消息。
 *
 * IM adapters（dingtalk/feishu）启动时调 registerImSender 注入发送函数。
 * 若某平台未注册，notifyImGroup 仅打 log，不抛错（避免阻断流程）。
 *
 * Phase 3 T10 扩展：DM sender 独立 registry —— 给 dm 节点 executor 用。
 * 与群消息 sender 分开,因为 IMAdapter.sendDirectMessage 接口签名不同。
 */

type SendFn = (groupId: string, text: string) => Promise<void>
type DmSendFn = (userId: string, text: string) => Promise<{ messageId?: string }>

const senders = new Map<string, SendFn>()
const dmSenders = new Map<string, DmSendFn>()

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

/** 注册 DM sender —— dm 节点 executor 通过 sendImDirect 触发。 */
export function registerImDmSender(platform: string, fn: DmSendFn): void {
  dmSenders.set(platform, fn)
}

export function hasImDmSender(platform: string): boolean {
  return dmSenders.has(platform)
}

/**
 * 给指定 platform 的某 user 发 DM。
 * 与 notifyImGroup 不同：DM 失败必须抛回调用方，因为 dm 节点 executor 需要把
 * 失败映射到 NodeExecutionResult.status='failed'。
 */
export async function sendImDirect(
  platform: string,
  userId: string,
  text: string,
): Promise<{ messageId?: string }> {
  const fn = dmSenders.get(platform)
  if (!fn) {
    throw new Error(`no DM sender registered for platform="${platform}"`)
  }
  return fn(userId, text)
}

/** 测试用：清空所有已注册 sender。 */
export function __clearImSendersForTest(): void {
  senders.clear()
  dmSenders.clear()
}
