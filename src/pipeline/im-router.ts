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

// ─── ParamCollectWaiter ──────────────────────────────────────────────────────
// 用于 im-param-collector 在 runPipeline 前采集参数时注册等待点。
// 与 ImWaiter（graph interrupt）平行，各自用独立的 Map。
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
