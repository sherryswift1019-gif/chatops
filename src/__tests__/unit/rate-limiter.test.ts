import { describe, it, expect, vi, beforeEach } from 'vitest'
import { withRateLimit } from '../../adapters/gitlab/rate-limiter.js'

describe('GitLab Rate Limiter', () => {
  it('executes function immediately when tokens available', async () => {
    const fn = vi.fn().mockResolvedValue('ok')
    const result = await withRateLimit('test-key', fn)
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledOnce()
  })

  it('retries on 429 status with exponential backoff', async () => {
    let callCount = 0
    const fn = vi.fn(async () => {
      callCount++
      if (callCount < 3) {
        const err = new Error('rate limited') as any
        err.response = { status: 429 }
        throw err
      }
      return 'success after retry'
    })

    const result = await withRateLimit('retry-key', fn, 3)
    expect(result).toBe('success after retry')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('throws after max retries on persistent 429', async () => {
    const fn = vi.fn(async () => {
      const err = new Error('rate limited') as any
      err.response = { status: 429 }
      throw err
    })

    await expect(withRateLimit('fail-key', fn, 2)).rejects.toThrow('rate limited')
    expect(fn).toHaveBeenCalledTimes(3) // initial + 2 retries
  })

  it('throws immediately on non-429 errors', async () => {
    const fn = vi.fn(async () => {
      const err = new Error('server error') as any
      err.response = { status: 500 }
      throw err
    })

    await expect(withRateLimit('error-key', fn)).rejects.toThrow('server error')
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
