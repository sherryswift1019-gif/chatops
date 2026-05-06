// src/e2e/pipeline-b/web-review-waiter.ts
//
// 内存 waiter：admin Web UI 触发的 e2e run 在 await_human_review gate 暂停时
// 没 IM 群可问，改在这里挂等 admin POST /e2e-runs/:runId/review-decision。
//
// 与 pipeline/im-router 上的 IM waiter 互不重叠：每个 run 同一时刻只可能在一个
// scenario 等审；按 runId（bigint→string key）单例，重复 register 会拒掉旧的。
//
// process restart 会丢 waiter——跟 await-human-review 旁边的 IM 等待现状一致；
// startup-recovery 把 in-flight runs 当 aborted 处理。
import type { HumanReviewDecision } from './types.js'

interface ReviewWaiter {
  scenarioRunId: bigint
  resolve: (d: HumanReviewDecision) => void
  reject: (err: Error) => void
}

const waiters = new Map<string, ReviewWaiter>()

function key(runId: bigint): string {
  return runId.toString()
}

/**
 * 等 admin UI 调 POST /e2e-runs/:runId/review-decision。
 * 已存在该 runId 的 waiter 会被旧 waiter reject 掉再注册新的（理论上不会发生，
 * 因为 graph 是顺序执行；防御性写法）。
 */
export function waitForWebReviewDecision(
  runId: bigint,
  scenarioRunId: bigint,
  timeoutMs: number,
): Promise<HumanReviewDecision> {
  return new Promise((resolve, reject) => {
    const k = key(runId)
    const old = waiters.get(k)
    if (old) {
      old.reject(new Error('superseded by new waiter'))
      waiters.delete(k)
    }

    const timer = setTimeout(() => {
      waiters.delete(k)
      reject(new Error(`web review wait timeout (${timeoutMs}ms)`))
    }, timeoutMs)

    waiters.set(k, {
      scenarioRunId,
      resolve: (d) => {
        clearTimeout(timer)
        waiters.delete(k)
        resolve(d)
      },
      reject: (err) => {
        clearTimeout(timer)
        waiters.delete(k)
        reject(err)
      },
    })
  })
}

/**
 * admin endpoint 调用：返回 'submitted' 表示成功 resolve；'no_waiter' 表示当前没
 * 等审者（可能 run 已经离开 await gate / 已超时 / 被其它进程处理）。
 */
export function submitWebReviewDecision(
  runId: bigint,
  decision: HumanReviewDecision,
): 'submitted' | 'no_waiter' {
  const w = waiters.get(key(runId))
  if (!w) return 'no_waiter'
  w.resolve(decision)
  return 'submitted'
}

/** 让 admin GET /e2e-runs/:runId 知道当前 run 是否在等 web 审（以及等的是哪个 scenario_run）。 */
export function getPendingWebReview(runId: bigint): { scenarioRunId: bigint } | null {
  const w = waiters.get(key(runId))
  return w ? { scenarioRunId: w.scenarioRunId } : null
}

/** 测试 only：清空全部。 */
export function _resetWebReviewWaitersForTest(): void {
  for (const w of waiters.values()) {
    w.reject(new Error('test reset'))
  }
  waiters.clear()
}
