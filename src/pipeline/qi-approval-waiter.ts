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

/** 测试辅助：清空所有 pending（每个测试用例 beforeEach 调用） */
export function clearQiApprovalWaiters(): void {
  pendingWaiters.clear()
}
