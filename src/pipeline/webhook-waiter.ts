/**
 * WebhookWaiter — Pipeline wait_webhook 阶段的暂停/恢复机制
 * 单例模式，内存中维护 tag → resolver 映射
 * webhook 到达时通过 resume(tag) 恢复对应的等待 Promise
 */

interface WaiterEntry {
  resolve: (data: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

export class WebhookWaiter {
  private static instance: WebhookWaiter | null = null
  private waiters = new Map<string, WaiterEntry>()

  static getInstance(): WebhookWaiter {
    if (!WebhookWaiter.instance) {
      WebhookWaiter.instance = new WebhookWaiter()
    }
    return WebhookWaiter.instance
  }

  /**
   * 注册等待，返回 Promise。webhook 到达或超时后 resolve。
   * @returns webhook 数据（成功）或 null（超时）
   */
  wait(tag: string, timeoutMs: number): Promise<{ data: unknown } | null> {
    // 清理已有的同 tag waiter（防重复）
    this.cancel(tag)

    return new Promise<{ data: unknown } | null>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(tag)
        console.log(`[WebhookWaiter] timeout: ${tag}`)
        resolve(null)
      }, timeoutMs)

      this.waiters.set(tag, {
        resolve: (data: unknown) => {
          clearTimeout(timer)
          this.waiters.delete(tag)
          resolve({ data })
        },
        timer,
      })

      console.log(`[WebhookWaiter] waiting: ${tag} (timeout ${timeoutMs}ms)`)
    })
  }

  /**
   * webhook 到达时调用，恢复对应的等待 Promise
   * @returns 是否有匹配的 waiter
   */
  resume(tag: string, data: unknown): boolean {
    const entry = this.waiters.get(tag)
    if (!entry) return false

    console.log(`[WebhookWaiter] resumed: ${tag}`)
    entry.resolve(data)
    return true
  }

  /** 取消等待 */
  cancel(tag: string): void {
    const entry = this.waiters.get(tag)
    if (entry) {
      clearTimeout(entry.timer)
      this.waiters.delete(tag)
    }
  }

  /** 当前等待数（用于监控） */
  get pendingCount(): number {
    return this.waiters.size
  }

  /** 重置（测试用） */
  static resetInstance(): void {
    if (WebhookWaiter.instance) {
      for (const entry of WebhookWaiter.instance.waiters.values()) {
        clearTimeout(entry.timer)
      }
      WebhookWaiter.instance.waiters.clear()
    }
    WebhookWaiter.instance = null
  }
}
