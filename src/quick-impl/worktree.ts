/**
 * Quick-Impl Worktree Manager
 *
 * 设计：docs/prds/prd-quick-impl.md §8.1 / §8.1.1
 *
 * 与 src/agent/worktree/manager.ts（e2e / bug-analysis 用）刻意路径与 cache 隔离：
 *   - WORKTREE_BASE_QI: /tmp/quick-impl/        (vs e2e 的 /tmp/analysis)
 *   - QI_REPO_CACHE_BASE: ~/.chatops-repos-qi/  (vs e2e 的 ~/.chatops-repos)
 * 避免两个 worktree 系统并发 git lock 冲突。
 *
 * 生命周期：requirements.status 终态后 30 min 由 cleanup hook 移除，本模块不做 TTL。
 *
 * Lockfile 机制（§8.1.1）防 cleanup race：
 *   - skill-runner 启 ClaudeRunner 前写 .qi-lock（pid + iso 时间）
 *   - ClaudeRunner 退出后删 .qi-lock
 *   - cleanup 入口：lockfile 存在 + pid alive → 跳过本次清；存在 + pid 死 → 视为孤儿 lockfile 删
 */
import { exec } from 'child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  unlinkSync,
} from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { injectGitlabAuth } from '../config/git-auth.js'

const execAsync = promisify(exec)

export const WORKTREE_BASE_QI =
  process.env.WORKTREE_BASE_QI ?? '/tmp/quick-impl'
export const QI_REPO_CACHE_BASE =
  process.env.QI_REPO_CACHE_BASE ?? join(homedir(), '.chatops-repos-qi')

export interface QiWorktree {
  requirementId: number
  path: string
  branch: string
  cachePath: string
  baseBranch: string
}

export interface AcquireWorktreeOptions {
  requirementId: number
  /** GitLab project path, e.g. 'group/repo' */
  gitlabProject: string
  /** Git URL（可不带 token，injectGitlabAuth 会注入） */
  gitUrl: string
  baseBranch?: string
  /** retry 用：附加后缀，分支名变 feat/qi-<id>-r<N>，路径 qi-<id>/r<N> */
  retryAttempt?: number
}

function projectSlug(gitlabProject: string): string {
  return gitlabProject.replace(/\//g, '-')
}

function buildBranchName(reqId: number, retryAttempt?: number): string {
  if (retryAttempt && retryAttempt > 1) {
    return `feat/qi-${reqId}-r${retryAttempt}`
  }
  return `feat/qi-${reqId}`
}

function buildWorktreePath(reqId: number, retryAttempt?: number): string {
  if (retryAttempt && retryAttempt > 1) {
    return join(WORKTREE_BASE_QI, `qi-${reqId}`, `r${retryAttempt}`)
  }
  return join(WORKTREE_BASE_QI, `qi-${reqId}`)
}

function buildCachePath(gitlabProject: string): string {
  return join(QI_REPO_CACHE_BASE, projectSlug(gitlabProject))
}

function validateBranchName(branch: string, label: string): void {
  if (!/^[a-zA-Z0-9_./-]+$/.test(branch)) {
    throw new Error(`[qi-worktree] invalid ${label}: ${branch}`)
  }
}

async function runGit(command: string, cwd?: string): Promise<string> {
  const opts = cwd ? { cwd, timeout: 120_000 } : { timeout: 120_000 }
  const { stdout } = await execAsync(command, opts)
  return stdout.trim()
}

/**
 * 确保 cache repo 存在并 fetch 最新。
 * 用 --bare clone + 自定义 refspec，与 src/agent/worktree/manager.ts 同思路：
 *   - bare 不占额外工作树
 *   - refspec 写入 refs/remotes/origin/* 而非 refs/heads/*
 *     避免 "refusing to fetch into branch checked out at worktree" 错误
 */
const cacheRepoInflight = new Map<string, Promise<string>>()

async function ensureCacheRepo(
  gitlabProject: string,
  gitUrl: string,
): Promise<string> {
  const inflight = cacheRepoInflight.get(gitlabProject)
  if (inflight) return inflight

  const p = _doEnsureCacheRepo(gitlabProject, gitUrl).finally(() => {
    cacheRepoInflight.delete(gitlabProject)
  })
  cacheRepoInflight.set(gitlabProject, p)
  return p
}

async function _doEnsureCacheRepo(
  gitlabProject: string,
  gitUrl: string,
): Promise<string> {
  const cachePath = buildCachePath(gitlabProject)

  if (existsSync(cachePath) && existsSync(join(cachePath, 'HEAD'))) {
    await runGit('git worktree prune', cachePath).catch(() => {})
    await runGit(
      'git config remote.origin.fetch "+refs/heads/*:refs/remotes/origin/*"',
      cachePath,
    )
    await runGit('git fetch origin --prune', cachePath)
    return cachePath
  }

  mkdirSync(cachePath, { recursive: true })
  const authedUrl = await injectGitlabAuth(gitUrl)
  await runGit(`git clone --bare ${authedUrl} ${cachePath}`)
  await runGit(
    'git config remote.origin.fetch "+refs/heads/*:refs/remotes/origin/*"',
    cachePath,
  )
  await runGit('git fetch origin --prune', cachePath)
  return cachePath
}

/**
 * 创建 worktree（§8.1）：在 cache 里 git worktree add 到独立路径，新建 feat/qi-<id> 分支。
 * 失败不残留：若中途出错，已建出的 worktree 会被 git worktree remove --force 清掉。
 */
export async function acquireWorktree(
  opts: AcquireWorktreeOptions,
): Promise<QiWorktree> {
  const baseBranch = opts.baseBranch ?? 'main'
  validateBranchName(baseBranch, 'baseBranch')
  const branch = buildBranchName(opts.requirementId, opts.retryAttempt)
  const wtPath = buildWorktreePath(opts.requirementId, opts.retryAttempt)

  const cachePath = await ensureCacheRepo(opts.gitlabProject, opts.gitUrl)

  if (existsSync(wtPath)) {
    // Idempotent: reuse existing worktree (e.g. pipeline re-run after failure).
    return {
      requirementId: opts.requirementId,
      path: wtPath,
      branch,
      cachePath,
      baseBranch,
    }
  }

  // git worktree add <path> -b <new-branch> origin/<base>
  // origin/<base> 是 detached HEAD source，避免与已 checkout 的 base 分支冲突
  mkdirSync(WORKTREE_BASE_QI, { recursive: true })
  if (opts.retryAttempt && opts.retryAttempt > 1) {
    mkdirSync(join(WORKTREE_BASE_QI, `qi-${opts.requirementId}`), {
      recursive: true,
    })
  }

  // Pre-clean: 上一次失败可能在 cache 里残留了同名 branch（worktree add 已 rollback
  // wtPath，但 branch 不会自动 cleanup）。prune stale worktrees + 删孤儿 branch。
  // branch -D 失败不致命：分支不存在 / 被其他 worktree 占用都会非 0 退出；后续
  // worktree add 会自然抛错，由外层 catch 处理。
  await runGit('git worktree prune', cachePath).catch(() => {})
  await runGit(`git branch -D ${branch}`, cachePath).catch(() => {})

  try {
    await runGit(
      `git worktree add ${wtPath} -b ${branch} origin/${baseBranch}`,
      cachePath,
    )
  } catch (err) {
    // 残留清理
    if (existsSync(wtPath)) {
      await runGit(`git worktree remove --force ${wtPath}`, cachePath).catch(
        () => {},
      )
      try {
        rmSync(wtPath, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
    throw err
  }

  return {
    requirementId: opts.requirementId,
    path: wtPath,
    branch,
    cachePath,
    baseBranch,
  }
}

/**
 * 移除 worktree（§8.1.1 安全删）：
 * 1. 检查 lockfile 是否还在 + pid 是否存活
 * 2. 存活 → 抛错（cleanup hook 应跳过，下个 tick 再试）
 * 3. 不存活 → 强删 lockfile + 走 git worktree remove --force，失败回退 rm -rf
 */
export async function removeWorktree(opts: {
  requirementId: number
  retryAttempt?: number
  cachePath?: string
  gitlabProject?: string
  /** force 跳过 lock 检查（abort 流程已等过 lock 释放后用） */
  force?: boolean
}): Promise<void> {
  const wtPath = buildWorktreePath(opts.requirementId, opts.retryAttempt)
  if (!existsSync(wtPath)) return

  const lockState = checkLock(wtPath)
  if (!opts.force && lockState === 'alive') {
    throw new WorktreeBusyError(
      `[qi-worktree] worktree ${wtPath} has active lockfile (pid alive)`,
    )
  }
  if (lockState === 'orphan') {
    // pid 死了，孤儿 lockfile 直接清
    try {
      unlinkSync(getLockPath(wtPath))
    } catch {
      /* ignore */
    }
  }

  // git worktree remove 需要 cachePath；调用方应当传，否则推断
  const cachePath =
    opts.cachePath ??
    (opts.gitlabProject ? buildCachePath(opts.gitlabProject) : null)

  if (cachePath && existsSync(cachePath)) {
    await runGit(`git worktree remove --force ${wtPath}`, cachePath).catch(
      () => {
        // 失败 fallback 到 rm -rf
        rmSync(wtPath, { recursive: true, force: true })
      },
    )
  } else {
    // 找不到 cache（可能已被独立清掉），直接强删
    rmSync(wtPath, { recursive: true, force: true })
  }
}

// =============================================================================
// Lockfile 机制（§8.1.1）
// =============================================================================

export class WorktreeBusyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorktreeBusyError'
  }
}

interface LockData {
  pid: number
  startedAt: string
  nodeId: string
}

function getLockPath(worktreePath: string): string {
  return join(worktreePath, '.qi-lock')
}

/**
 * 写 lockfile（skill-runner 启 ClaudeRunner 前调）。
 * 不防并发——同一 worktree 串行执行多个 skill 节点，每节点拿锁前先释放上一个。
 */
export function acquireLock(
  worktreePath: string,
  pid: number,
  nodeId: string,
): void {
  if (!existsSync(worktreePath)) {
    throw new Error(`[qi-worktree] worktree path not found: ${worktreePath}`)
  }
  const data: LockData = {
    pid,
    startedAt: new Date().toISOString(),
    nodeId,
  }
  writeFileSync(getLockPath(worktreePath), JSON.stringify(data, null, 2))
}

export function releaseLock(worktreePath: string): void {
  const lockPath = getLockPath(worktreePath)
  if (existsSync(lockPath)) {
    try {
      unlinkSync(lockPath)
    } catch {
      /* ignore — best effort */
    }
  }
}

/**
 * 检查 lockfile 状态：
 *   - 'absent'  无 lockfile（无活跃 ClaudeRunner，可清）
 *   - 'alive'   有 lockfile + pid 存活（不可清）
 *   - 'orphan'  有 lockfile + pid 死亡（可清，孤儿残留）
 */
export type LockState = 'absent' | 'alive' | 'orphan'

export function checkLock(worktreePath: string): LockState {
  const lockPath = getLockPath(worktreePath)
  if (!existsSync(lockPath)) return 'absent'
  try {
    const raw = readFileSync(lockPath, 'utf8')
    const data = JSON.parse(raw) as LockData
    if (typeof data.pid !== 'number' || data.pid <= 0) return 'orphan'
    return isPidAlive(data.pid) ? 'alive' : 'orphan'
  } catch {
    // lockfile 损坏（手改 / 写中段崩），视为孤儿可清
    return 'orphan'
  }
}

export function readLockData(worktreePath: string): LockData | null {
  const lockPath = getLockPath(worktreePath)
  if (!existsSync(lockPath)) return null
  try {
    return JSON.parse(readFileSync(lockPath, 'utf8')) as LockData
  } catch {
    return null
  }
}

function isPidAlive(pid: number): boolean {
  try {
    // process.kill(pid, 0) 不实际发信号，仅校验权限 / 进程存在
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// =============================================================================
// 列表 / 配额检查
// =============================================================================

/**
 * 扫 WORKTREE_BASE_QI 下所有 qi-<id>* 目录，返回 (reqId, path) 对。
 * cleanup hook 用来扫描"哪些 worktree 该清"。
 */
export async function listLiveWorktrees(): Promise<
  Array<{ requirementId: number; path: string; retryAttempt?: number }>
> {
  if (!existsSync(WORKTREE_BASE_QI)) return []
  const entries: Array<{
    requirementId: number
    path: string
    retryAttempt?: number
  }> = []

  for (const name of readdirSync(WORKTREE_BASE_QI)) {
    const m = /^qi-(\d+)$/.exec(name)
    if (!m) continue
    const reqId = Number(m[1])
    const baseDir = join(WORKTREE_BASE_QI, name)
    let isDir = false
    try {
      isDir = statSync(baseDir).isDirectory()
    } catch {
      continue
    }
    if (!isDir) continue

    // 主 worktree（无 -r 后缀）
    if (existsSync(join(baseDir, '.git'))) {
      entries.push({ requirementId: reqId, path: baseDir })
    }

    // retry 子目录 r2/r3...
    for (const sub of readdirSync(baseDir).filter((s) => /^r\d+$/.test(s))) {
      const subPath = join(baseDir, sub)
      try {
        if (
          statSync(subPath).isDirectory() &&
          existsSync(join(subPath, '.git'))
        ) {
          entries.push({
            requirementId: reqId,
            path: subPath,
            retryAttempt: Number(sub.slice(1)),
          })
        }
      } catch {
        /* ignore */
      }
    }
  }

  return entries
}

export async function countLiveWorktrees(): Promise<number> {
  return (await listLiveWorktrees()).length
}
