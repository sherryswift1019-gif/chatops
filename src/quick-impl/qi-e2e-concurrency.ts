/**
 * Quick-Impl E2E 并发控制信号量
 *
 * 设计：docs/prds/prd-quick-impl-e2e-phase2.md - "并发控制 + 总耗时透明度"
 *
 * runE2eScenario 用全局单例 ClaudeRunner（getRunner()）。多个 QI run 并行调
 * qi_e2e_runner 节点时 ClaudeRunner session / Playwright 进程会争抢。
 * 串行最稳（默认 N=1，跟 fix-runner 一致）；上线观察 1 周后可调到 2-3。
 */

const QI_E2E_CONCURRENCY = Math.max(
  1,
  Math.floor(Number(process.env.QI_E2E_CONCURRENCY ?? 1)),
)

let inFlight = 0
const queue: Array<() => void> = []

/**
 * 申请并发槽位，不可用时排队等待。返回 release 函数。
 *
 * 用法：
 *   const release = await acquireQiE2eSlot()
 *   try { ... 跑 e2e ... } finally { release() }
 */
export async function acquireQiE2eSlot(): Promise<() => void> {
  if (inFlight < QI_E2E_CONCURRENCY) {
    inFlight += 1
    return makeReleaser()
  }
  return new Promise<() => void>((resolve) => {
    queue.push(() => {
      inFlight += 1
      resolve(makeReleaser())
    })
  })
}

function makeReleaser(): () => void {
  let released = false
  return () => {
    if (released) return
    released = true
    inFlight -= 1
    const next = queue.shift()
    if (next) next()
  }
}

/** 仅供单测：重置内部状态 */
export function __resetQiE2eConcurrencyForTesting(): void {
  inFlight = 0
  queue.length = 0
}

/** 仅供单测：当前 in-flight 数 */
export function __qiE2eInFlight(): number {
  return inFlight
}

/** 仅供单测：当前 queue 长度 */
export function __qiE2eQueueLen(): number {
  return queue.length
}

export function getQiE2eConcurrency(): number {
  return QI_E2E_CONCURRENCY
}
