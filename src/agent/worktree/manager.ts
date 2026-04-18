import { exec } from 'child_process'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { promisify } from 'util'

const execAsync = promisify(exec)

const WORKTREE_BASE = process.env.WORKTREE_BASE ?? '/tmp/analysis'
const REPO_CACHE_BASE = process.env.REPO_CACHE_BASE ?? join(homedir(), '.chatops-repos')
const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000 // 2 小时统一 TTL

export interface Worktree {
  id: string
  path: string
  userId: string
  product: string
  version: string
  sessionId: string
  repoUrl: string
  createdAt: Date
  expiresAt: Date
}

export interface AcquireOptions {
  userId: string
  product: string
  version: string
  sessionId: string
  repoUrl: string
}

const activeWorktrees = new Map<string, Worktree>()

function buildId(opts: AcquireOptions): string {
  return `${opts.userId}-${opts.product}-${opts.version}-${opts.sessionId}`
}

function buildWorktreePath(id: string): string {
  return join(WORKTREE_BASE, id)
}

function buildRepoCachePath(product: string): string {
  return join(REPO_CACHE_BASE, product)
}

async function runGit(command: string, cwd?: string): Promise<string> {
  const opts = cwd ? { cwd, timeout: 120_000 } : { timeout: 120_000 }
  const { stdout } = await execAsync(command, opts)
  return stdout.trim()
}

async function ensureMainRepo(product: string, repoUrl: string): Promise<string> {
  const cachePath = buildRepoCachePath(product)

  if (existsSync(join(cachePath, '.git')) || existsSync(join(cachePath, 'HEAD'))) {
    await runGit('git worktree prune', cachePath).catch(() => {})
    await runGit('git fetch --all --prune', cachePath)
    return cachePath
  }

  mkdirSync(cachePath, { recursive: true })
  await runGit(`git clone --bare ${repoUrl} ${cachePath}`)
  return cachePath
}

export async function acquire(opts: AcquireOptions): Promise<Worktree> {
  const id = buildId(opts)
  const wtPath = buildWorktreePath(id)

  if (activeWorktrees.has(id)) {
    const existing = activeWorktrees.get(id)!
    existing.expiresAt = new Date(Date.now() + DEFAULT_TTL_MS)
    return existing
  }

  const mainRepoPath = await ensureMainRepo(opts.product, opts.repoUrl)

  if (existsSync(wtPath)) {
    await runGit(`git worktree remove --force ${wtPath}`, mainRepoPath).catch(err => {
      console.warn(`[Worktree] failed to remove stale worktree ${wtPath}:`, err)
    })
  }

  // 使用 --detach 避免锁定分支名，允许多个会话并行分析同一分支
  await runGit(`git worktree add --detach ${wtPath} ${opts.version}`, mainRepoPath)

  const worktree: Worktree = {
    id,
    path: wtPath,
    userId: opts.userId,
    product: opts.product,
    version: opts.version,
    sessionId: opts.sessionId,
    repoUrl: opts.repoUrl,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + DEFAULT_TTL_MS),
  }

  activeWorktrees.set(id, worktree)
  console.log(`[Worktree] acquired: ${wtPath} (branch: ${opts.version}, TTL: 2h)`)
  return worktree
}

export function release(worktree: Worktree): void {
  console.log(`[Worktree] released: ${worktree.path} (will expire at ${worktree.expiresAt.toISOString()})`)
}

export async function remove(worktree: Worktree): Promise<void> {
  const mainRepoPath = buildRepoCachePath(worktree.product)
  try {
    await runGit(`git worktree remove --force ${worktree.path}`, mainRepoPath)
  } catch (err) {
    console.error(`[Worktree] git worktree remove failed for ${worktree.path}:`, err)
  }
  activeWorktrees.delete(worktree.id)
  console.log(`[Worktree] removed: ${worktree.path}`)
}

export async function cleanup(): Promise<number> {
  const now = Date.now()
  let cleaned = 0

  for (const [id, wt] of activeWorktrees) {
    if (wt.expiresAt.getTime() < now) {
      await remove(wt).catch(err => {
        console.error(`[Worktree] cleanup error for ${wt.path}:`, err)
      })
      cleaned++
    }
  }

  if (cleaned > 0) {
    console.log(`[Worktree] cleanup: removed ${cleaned} expired worktrees`)
  }
  return cleaned
}

/** 兜底清理：移除所有 worktree（凌晨 3 点调用，防磁盘泄漏） */
export async function cleanupAll(): Promise<number> {
  let cleaned = 0
  for (const [id, wt] of activeWorktrees) {
    await remove(wt).catch(err => {
      console.error(`[Worktree] cleanupAll error for ${wt.path}:`, err)
    })
    cleaned++
  }
  // 清理孤立目录
  try {
    const { readdirSync, rmSync } = await import('fs')
    if (existsSync(WORKTREE_BASE)) {
      for (const dir of readdirSync(WORKTREE_BASE)) {
        const fullPath = join(WORKTREE_BASE, dir)
        rmSync(fullPath, { recursive: true, force: true })
        cleaned++
      }
    }
  } catch (err) {
    console.error('[Worktree] cleanupAll dir cleanup error:', err)
  }
  console.log(`[Worktree] cleanupAll: removed ${cleaned} items`)
  return cleaned
}

export function getActive(): Worktree[] {
  return [...activeWorktrees.values()]
}

export function getById(id: string): Worktree | undefined {
  return activeWorktrees.get(id)
}
