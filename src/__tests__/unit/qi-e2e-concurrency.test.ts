/**
 * QI E2E concurrency semaphore 测试
 * 默认 QI_E2E_CONCURRENCY=1，本测试假设这个默认行为。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  acquireQiE2eSlot,
  __resetQiE2eConcurrencyForTesting,
  __qiE2eInFlight,
  __qiE2eQueueLen,
  getQiE2eConcurrency,
} from '../../quick-impl/qi-e2e-concurrency.js'

describe('qi-e2e-concurrency', () => {
  beforeEach(() => {
    __resetQiE2eConcurrencyForTesting()
  })

  it('默认并发上限 = 1', () => {
    expect(getQiE2eConcurrency()).toBe(1)
  })

  it('单个 acquire → 立即拿到 slot，inFlight=1', async () => {
    expect(__qiE2eInFlight()).toBe(0)
    const release = await acquireQiE2eSlot()
    expect(__qiE2eInFlight()).toBe(1)
    release()
    expect(__qiE2eInFlight()).toBe(0)
  })

  it('第二个 acquire 在第一个 release 前必须等', async () => {
    const r1 = await acquireQiE2eSlot()
    expect(__qiE2eInFlight()).toBe(1)

    let r2Acquired = false
    const p2 = acquireQiE2eSlot().then((rel) => {
      r2Acquired = true
      return rel
    })

    // 让微任务跑完
    await new Promise((resolve) => setImmediate(resolve))
    expect(r2Acquired).toBe(false)
    expect(__qiE2eQueueLen()).toBe(1)

    r1()
    const r2 = await p2
    expect(r2Acquired).toBe(true)
    expect(__qiE2eInFlight()).toBe(1)
    expect(__qiE2eQueueLen()).toBe(0)
    r2()
  })

  it('多次 acquire 按 FIFO 顺序释放', async () => {
    const r1 = await acquireQiE2eSlot()
    const order: number[] = []

    const p2 = acquireQiE2eSlot().then((rel) => {
      order.push(2)
      return rel
    })
    const p3 = acquireQiE2eSlot().then((rel) => {
      order.push(3)
      return rel
    })

    await new Promise((resolve) => setImmediate(resolve))
    expect(__qiE2eQueueLen()).toBe(2)

    r1()
    const r2 = await p2
    expect(order).toEqual([2])

    r2()
    const r3 = await p3
    expect(order).toEqual([2, 3])

    r3()
    expect(__qiE2eInFlight()).toBe(0)
  })

  it('release 幂等：多次调用只减 1', async () => {
    const release = await acquireQiE2eSlot()
    expect(__qiE2eInFlight()).toBe(1)
    release()
    release()
    release()
    expect(__qiE2eInFlight()).toBe(0)
  })
})
