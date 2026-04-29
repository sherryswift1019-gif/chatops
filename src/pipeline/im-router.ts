/**
 * im-router — 维护 IM 群参数采集等待表（im-param-collector 用）。
 *
 * 仅保留 ParamCollectWaiter section：在 runPipeline 前由 im-param-collector
 * 注册 (platform, groupId) → resolve/reject 回调，session-manager 收到该群下
 * 一条消息时直接 resolve，不进入 Agent 流程。
 */

const groupKey = (platform: string, groupId: string): string => `${platform}:${groupId}`

// ─── ParamCollectWaiter ──────────────────────────────────────────────────────
// 用于 im-param-collector 在 runPipeline 前采集参数时注册等待点。
// session-manager 优先检查此 waiter，命中则直接 resolve，不进入 Agent 流程。

export interface ParamCollectWaiter {
  platform: string
  groupId: string
  resolve: (message: string) => void
  reject: (err: Error) => void
}

const byGroupCollect = new Map<string, ParamCollectWaiter>()

export function registerParamCollectWaiter(w: ParamCollectWaiter): void {
  const key = groupKey(w.platform, w.groupId)
  const existing = byGroupCollect.get(key)
  if (existing) {
    existing.reject(new Error('新的参数采集请求替换了旧的等待'))
  }
  byGroupCollect.set(key, w)
}

export function unregisterParamCollectWaiter(platform: string, groupId: string): void {
  byGroupCollect.delete(groupKey(platform, groupId))
}

export function findParamCollectWaiter(platform: string, groupId: string): ParamCollectWaiter | null {
  return byGroupCollect.get(groupKey(platform, groupId)) ?? null
}
