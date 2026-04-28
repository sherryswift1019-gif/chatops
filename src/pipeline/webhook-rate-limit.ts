interface RateWindow {
  count: number
  windowStart: number
}

export type CheckResult =
  | { allowed: true }
  | { allowed: false; retryAfter: number }

/**
 * 进程内 sliding-window 限流器。
 * v1 故意单进程——多副本不保证一致性，下版引 Redis 时替换。
 */
export class RateLimiter {
  private readonly windows = new Map<string, RateWindow>()

  constructor(
    private readonly maxRequests: number = 60,
    private readonly windowMs: number = 60_000,
  ) {}

  check(token: string): CheckResult {
    const now = Date.now()
    const win = this.windows.get(token)

    if (!win || now - win.windowStart >= this.windowMs) {
      this.windows.set(token, { count: 1, windowStart: now })
      return { allowed: true }
    }

    if (win.count < this.maxRequests) {
      win.count++
      return { allowed: true }
    }

    const retryAfter = Math.ceil((this.windowMs - (now - win.windowStart)) / 1000)
    return { allowed: false, retryAfter }
  }
}

// 全局单例供 webhook-router 直接 import
export const globalRateLimiter = new RateLimiter()
