import { describe, it, expect, vi, beforeEach } from 'vitest'
import { retryWithDowngrade } from '../../agent/fix/retry-handler.js'
import type { RetryContext } from '../../agent/fix/retry-handler.js'

describe('retryWithDowngrade', () => {
  it('returns success on first attempt if fix succeeds', async () => {
    const fixAttempt = vi.fn().mockResolvedValue({ success: true, output: 'fixed' })
    const onDowngrade = vi.fn()

    const result = await retryWithDowngrade(123, 'l2', fixAttempt, onDowngrade)

    expect(result.success).toBe(true)
    expect(fixAttempt).toHaveBeenCalledTimes(1)
    expect(onDowngrade).not.toHaveBeenCalled()
  })

  it('retries up to 3 times on failure', async () => {
    const fixAttempt = vi.fn().mockResolvedValue({ success: false, error: 'test fail' })
    const onDowngrade = vi.fn()

    const result = await retryWithDowngrade(456, 'l2', fixAttempt, onDowngrade)

    expect(result.success).toBe(false)
    expect(fixAttempt).toHaveBeenCalledTimes(3)
  })

  it('triggers downgrade after 3 failures', async () => {
    const fixAttempt = vi.fn().mockResolvedValue({ success: false, error: 'fail' })
    const onDowngrade = vi.fn()

    await retryWithDowngrade(789, 'l1', fixAttempt, onDowngrade)

    expect(onDowngrade).toHaveBeenCalledOnce()
    expect(onDowngrade).toHaveBeenCalledWith(expect.objectContaining({
      issueId: 789,
      level: 'l1',
      attempt: 3,
    }))
  })

  it('stops retrying after first success', async () => {
    let callCount = 0
    const fixAttempt = vi.fn(async () => {
      callCount++
      if (callCount < 2) return { success: false, error: 'fail' }
      return { success: true, output: 'fixed on 2nd try' }
    })
    const onDowngrade = vi.fn()

    const result = await retryWithDowngrade(101, 'l2', fixAttempt, onDowngrade)

    expect(result.success).toBe(true)
    expect(fixAttempt).toHaveBeenCalledTimes(2)
    expect(onDowngrade).not.toHaveBeenCalled()
  })

  it('passes correct attempt number to fixAttempt', async () => {
    const attempts: number[] = []
    const fixAttempt = vi.fn(async (ctx: RetryContext) => {
      attempts.push(ctx.attempt)
      return { success: false, error: 'fail' }
    })

    await retryWithDowngrade(202, 'l2', fixAttempt, vi.fn())

    expect(attempts).toEqual([1, 2, 3])
  })
})
