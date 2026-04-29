/**
 * im-router — 维护"正在等 IM 输入的 pipeline run"注册表。
 *
 * IM adapter 收到消息时先查 findRunExpectingInput()，命中则把消息作为
 * resumeValue 调 graph-runner.resumeRun()；否则走普通 SessionManager。
 *
 * 纯内存实现：pipeline 的 interrupt 状态本身已持久化在 checkpointer 里，
 * 这里只需要记录"哪个群的下一条消息应该喂给哪个 run"。进程重启后若
 * 存在未完成的 im_input interrupt，重放 interrupt payload 即可重建
 * （v2 再做；v1 靠 stage 超时兜底）。
 */

export interface ImWaiterKey {
  runId: number
  stageIndex: number
}

export interface ImWaiter extends ImWaiterKey {
  platform: string
  groupId: string
}

const byRun = new Map<string, ImWaiter>()      // `${runId}:${stageIndex}`
const byGroup = new Map<string, ImWaiter>()    // `${platform}:${groupId}`

const runKey = (k: ImWaiterKey): string => `${k.runId}:${k.stageIndex}`
const groupKey = (platform: string, groupId: string): string => `${platform}:${groupId}`

export function registerImWaiter(w: ImWaiter): void {
  // 若目标群已有 waiter，先把它的 run 索引清掉，避免孤儿映射
  const existing = byGroup.get(groupKey(w.platform, w.groupId))
  if (existing) {
    byRun.delete(runKey(existing))
  }
  byRun.set(runKey(w), w)
  byGroup.set(groupKey(w.platform, w.groupId), w)
}

export function unregisterImWaiter(k: ImWaiterKey): void {
  const w = byRun.get(runKey(k))
  if (!w) return
  byRun.delete(runKey(k))
  byGroup.delete(groupKey(w.platform, w.groupId))
}

export function findRunExpectingInput(platform: string, groupId: string): ImWaiterKey | null {
  const w = byGroup.get(groupKey(platform, groupId))
  return w ? { runId: w.runId, stageIndex: w.stageIndex } : null
}

export function isGroupBusy(platform: string, groupId: string): boolean {
  return byGroup.has(groupKey(platform, groupId))
}

export function listWaiters(): ImWaiter[] {
  return Array.from(byRun.values())
}

/**
 * ParamCollectWaiter — 轻量的"等一条 IM 消息用于参数采集"注册表。
 *
 * 与 ImWaiter（graph interrupt 恢复）独立，优先级更高：
 * session-manager 先检查 paramCollect waiter，命中则直接 resolve，
 * 不进入 Agent / graph 流程。
 */

export interface ParamCollectWaiter {
  resolve(message: string): void
}

const paramWaiters = new Map<string, ParamCollectWaiter>()  // `${platform}:${groupId}`

export function registerParamCollectWaiter(
  platform: string,
  groupId: string,
  waiter: ParamCollectWaiter
): void {
  paramWaiters.set(groupKey(platform, groupId), waiter)
}

export function unregisterParamCollectWaiter(platform: string, groupId: string): void {
  paramWaiters.delete(groupKey(platform, groupId))
}

export function findParamCollectWaiter(
  platform: string,
  groupId: string
): ParamCollectWaiter | null {
  return paramWaiters.get(groupKey(platform, groupId)) ?? null
}
