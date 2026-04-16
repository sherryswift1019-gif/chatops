import { cleanup } from './manager.js'

const CLEANUP_CRON = process.env.WORKTREE_CLEANUP_CRON ?? '0 3 * * *' // 默认凌晨 3 点

let intervalId: ReturnType<typeof setInterval> | null = null

export function startCleanupScheduler(): void {
  // 每小时检查一次过期 worktree（TTL 2h）
  intervalId = setInterval(async () => {
    try {
      await cleanup()
    } catch (err) {
      console.error('[Worktree] scheduled cleanup error:', err)
    }
  }, 60 * 60 * 1000) // 1 小时

  console.log('[Worktree] cleanup scheduler started (interval: 1h)')
}

export function stopCleanupScheduler(): void {
  if (intervalId) {
    clearInterval(intervalId)
    intervalId = null
    console.log('[Worktree] cleanup scheduler stopped')
  }
}
