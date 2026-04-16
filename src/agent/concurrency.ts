/**
 * 全局并发计数器。
 * TaskQueue.run() 在实际执行 executor 时调 increment/decrement，
 * SessionManager 在 processMessage 时做准入检查。
 */
import { getConfig } from '../db/repositories/system-config.js'

let activeCount = 0
let maxConcurrency = 10
let cachedAt = 0

export async function getMaxConcurrency(): Promise<number> {
  if (Date.now() - cachedAt > 60_000) {
    try {
      const cfg = await getConfig('platform')
      const val = (cfg?.value as Record<string, unknown>)?.max_concurrency
      if (val) maxConcurrency = Number(val) || 10
    } catch { /* DB unavailable — keep previous value */ }
    cachedAt = Date.now()
  }
  return maxConcurrency
}

export function getActiveCount(): number { return activeCount }
export function incrementActive(): void { activeCount++ }
export function decrementActive(): void { activeCount-- }
