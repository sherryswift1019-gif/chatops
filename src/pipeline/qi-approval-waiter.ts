/**
 * QI Approval Waiter Registry
 *
 * 内存注册表：graph-runner.ts 在收到 qi_approval interrupt 时调 registerQiApprovalWaiter
 * 登记 (waiterId → { runId, loopState })；admin claim 端点成功 claim 后调 getQiApprovalInfo
 * 拿到 runId 发 Command({resume}) 恢复 LangGraph 图。
 *
 * 设计：不导入 graph-runner 避免循环依赖。
 * 调用方：
 *   - graph-runner.ts:dispatchInterrupt      → registerQiApprovalWaiter / removeQiApprovalWaiter
 *   - graph-runner.ts:resumeFromQiApproval   → getQiApprovalInfo + removeQiApprovalWaiter
 */
import type { ApprovalLoopState } from './graph-builder.js'

export interface QiApprovalPendingInfo {
  runId: number
  loopState: ApprovalLoopState
}

/** waiterId → pending info */
const pendingWaiters = new Map<number, QiApprovalPendingInfo>()

export function registerQiApprovalWaiter(
  waiterId: number,
  info: QiApprovalPendingInfo,
): void {
  pendingWaiters.set(waiterId, info)
}

export function getQiApprovalInfo(waiterId: number): QiApprovalPendingInfo | null {
  return pendingWaiters.get(waiterId) ?? null
}

export function removeQiApprovalWaiter(waiterId: number): void {
  pendingWaiters.delete(waiterId)
}

/**
 * 删除某 runId 下所有 pending waiter，返回被删的 waiterId 列表。
 *
 * graph-runner.finalize() 用：pipeline 提前终止（onFailure=stop 触发 finalize）
 * 时清理该 run 残留的 QI waiter 注册，避免 timer 到期后 resumeFromQiApproval
 * 在已 finalize 的 run 上 ghost-resume。
 */
export function clearQiApprovalWaitersByRunId(runId: number): number[] {
  const removed: number[] = []
  for (const [waiterId, info] of pendingWaiters) {
    if (info.runId === runId) {
      removed.push(waiterId)
    }
  }
  for (const w of removed) pendingWaiters.delete(w)
  return removed
}

/** 测试辅助：清空所有 pending（每个测试用例 beforeEach 调用） */
export function clearQiApprovalWaiters(): void {
  pendingWaiters.clear()
}
