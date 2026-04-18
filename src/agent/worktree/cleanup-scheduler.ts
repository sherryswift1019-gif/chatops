import { cleanup, cleanupAll } from './manager.js'

let intervalId: ReturnType<typeof setInterval> | null = null
let dailyTimerId: ReturnType<typeof setTimeout> | null = null

export function startCleanupScheduler(): void {
  // 每小时检查一次过期 worktree（TTL 2h）
  intervalId = setInterval(async () => {
    try {
      await cleanup()
    } catch (err) {
      console.error('[Worktree] scheduled cleanup error:', err)
    }
  }, 60 * 60 * 1000)

  // 凌晨 3 点兜底清理所有临时目录（防磁盘泄漏）
  scheduleDailyCleanup()

  console.log('[Worktree] cleanup scheduler started (interval: 1h, daily: 03:00)')
}

function scheduleDailyCleanup(): void {
  const now = new Date()
  const next3am = new Date(now)
  next3am.setHours(3, 0, 0, 0)
  if (next3am.getTime() <= now.getTime()) {
    next3am.setDate(next3am.getDate() + 1)
  }
  const delay = next3am.getTime() - now.getTime()

  dailyTimerId = setTimeout(async () => {
    console.log('[Worktree] daily cleanup: removing all worktrees')
    try {
      await cleanupAll()
    } catch (err) {
      console.error('[Worktree] daily cleanup error:', err)
    }
    // 下一天再调度
    scheduleDailyCleanup()
  }, delay)
}

export function stopCleanupScheduler(): void {
  if (intervalId) {
    clearInterval(intervalId)
    intervalId = null
  }
  if (dailyTimerId) {
    clearTimeout(dailyTimerId)
    dailyTimerId = null
  }
  console.log('[Worktree] cleanup scheduler stopped')
}
