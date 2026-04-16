/**
 * project+env 写操作互斥锁（内存，主进程内共享）。
 * deploy/rollback/restart 同一 project:env 同时只能有一个在执行。
 */

interface LockEntry {
  userId: string
  action: string
  since: number
}

const locks = new Map<string, LockEntry>()
const LOCK_TIMEOUT = 10 * 60 * 1000 // 10 分钟超时保护

export function acquireLock(project: string, env: string, userId: string, action: string): string | null {
  const key = `${project}:${env}`
  const existing = locks.get(key)
  if (existing && (Date.now() - existing.since < LOCK_TIMEOUT)) {
    console.log(`[DeployLock] Blocked ${key} — held by ${existing.userId} (${existing.action})`)
    return `⏳ ${project} (${env}) 正在被执行${existing.action}操作，请稍后再试。`
  }
  locks.set(key, { userId, action, since: Date.now() })
  console.log(`[DeployLock] Acquired ${key} by ${userId} (${action})`)
  return null
}

export function releaseLock(project: string, env: string, userId: string): void {
  const key = `${project}:${env}`
  const existing = locks.get(key)
  if (existing && existing.userId === userId) {
    locks.delete(key)
    console.log(`[DeployLock] Released ${key} by ${userId}`)
  }
  // 不是自己的锁 → 不动（可能已超时被别人接管）
}
