import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { RateLimiter } from '../../pipeline/webhook-rate-limit.js'

describe('RateLimiter', () => {
  let limiter: RateLimiter

  beforeEach(() => {
    limiter = new RateLimiter(3, 60_000) // 3 次/60s，便于测试
    vi.useFakeTimers()
  })

  afterEach(() => vi.useRealTimers())

  it('窗口内 3 次请求都通过', () => {
    expect(limiter.check('tok1')).toEqual({ allowed: true })
    expect(limiter.check('tok1')).toEqual({ allowed: true })
    expect(limiter.check('tok1')).toEqual({ allowed: true })
  })

  it('第 4 次拒绝并返回 retryAfter', () => {
    limiter.check('tok1')
    limiter.check('tok1')
    limiter.check('tok1')
    const result = limiter.check('tok1')
    expect(result.allowed).toBe(false)
    expect((result as { allowed: false; retryAfter: number }).retryAfter).toBeGreaterThan(0)
  })

  it('不同 token 互不影响', () => {
    limiter.check('tok1'); limiter.check('tok1'); limiter.check('tok1')
    expect(limiter.check('tok2')).toEqual({ allowed: true })
  })

  it('窗口过期后恢复', () => {
    limiter.check('tok1'); limiter.check('tok1'); limiter.check('tok1')
    vi.advanceTimersByTime(61_000)
    expect(limiter.check('tok1')).toEqual({ allowed: true })
  })
})
