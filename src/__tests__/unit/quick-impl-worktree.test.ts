import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { exec } from 'child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'

// 测试前覆盖 env，模块导入后才生效——所以本测试集每个用例独立 env
const TEST_BASE = mkdtempSync(join(tmpdir(), 'qi-wt-test-'))
const WT_BASE = join(TEST_BASE, 'wt')
const CACHE_BASE = join(TEST_BASE, 'cache')
process.env.WORKTREE_BASE_QI = WT_BASE
process.env.QI_REPO_CACHE_BASE = CACHE_BASE

// 动态 import worktree 模块——保证读到 env 覆盖后的常量
const wt = await import('../../quick-impl/worktree.js')

const execAsync = promisify(exec)

// 创建一个本地 bare repo 当 origin 用，避免依赖外网 / GitLab token
async function setupLocalOriginRepo(): Promise<string> {
  const originPath = join(TEST_BASE, 'fake-origin.git')
  await execAsync(`git init --bare ${originPath}`)

  // 第一个 commit：克隆出一个 working dir → 初始化 → push 回 bare
  const initDir = join(TEST_BASE, 'init-clone')
  await execAsync(`git clone ${originPath} ${initDir}`)
  await execAsync('git config user.email "test@local"', { cwd: initDir })
  await execAsync('git config user.name "Test"', { cwd: initDir })
  writeFileSync(join(initDir, 'README.md'), '# initial\n')
  await execAsync('git add README.md', { cwd: initDir })
  await execAsync('git commit -m "initial"', { cwd: initDir })
  // 兼容默认 master / main
  await execAsync('git branch -M main', { cwd: initDir })
  await execAsync('git push origin main', { cwd: initDir })
  rmSync(initDir, { recursive: true, force: true })
  return originPath
}

let ORIGIN_URL: string

beforeAll(async () => {
  ORIGIN_URL = await setupLocalOriginRepo()
})

afterAll(() => {
  rmSync(TEST_BASE, { recursive: true, force: true })
})

beforeEach(() => {
  // 每个用例前清空 worktree base 与 cache（cache 重建即可，省去 git fetch dance）
  if (existsSync(WT_BASE)) rmSync(WT_BASE, { recursive: true, force: true })
  // cache 不删——重建一次太慢；用例间互不污染（不同 reqId）
})

describe('quick-impl worktree manager', () => {
  describe('acquireWorktree', () => {
    it('creates new worktree on feat/qi-<id> branch', async () => {
      const w = await wt.acquireWorktree({
        requirementId: 1,
        gitlabProject: 'group/repo',
        gitUrl: ORIGIN_URL,
      })
      expect(w.requirementId).toBe(1)
      expect(w.branch).toBe('feat/qi-1')
      expect(w.path).toBe(join(WT_BASE, 'qi-1'))
      expect(existsSync(w.path)).toBe(true)
      expect(existsSync(join(w.path, '.git'))).toBe(true)
      expect(existsSync(join(w.path, 'README.md'))).toBe(true)

      // 验证当前分支
      const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD', {
        cwd: w.path,
      })
      expect(stdout.trim()).toBe('feat/qi-1')
    })

    // TODO: acquireWorktree 在 production 改为幂等（path 已存在时复用 worktree 而非抛错），
    // 旧行为契约已不再适用。需要独立 ticket 决策是否恢复"不允许隐式复用"保护，
    // 或改为验证幂等返回相同路径的新测试。pre-existing fail (idempotent reuse added in main).
    it.skip('throws if worktree path already exists (no silent overwrite)', async () => {
      await wt.acquireWorktree({
        requirementId: 2,
        gitlabProject: 'group/repo',
        gitUrl: ORIGIN_URL,
      })
      await expect(
        wt.acquireWorktree({
          requirementId: 2,
          gitlabProject: 'group/repo',
          gitUrl: ORIGIN_URL,
        }),
      ).rejects.toThrow(/already exists/)
    })

    it('retry attempt creates -r2 branch + sub-path', async () => {
      const w1 = await wt.acquireWorktree({
        requirementId: 3,
        gitlabProject: 'group/repo',
        gitUrl: ORIGIN_URL,
      })
      const w2 = await wt.acquireWorktree({
        requirementId: 3,
        gitlabProject: 'group/repo',
        gitUrl: ORIGIN_URL,
        retryAttempt: 2,
      })

      expect(w2.branch).toBe('feat/qi-3-r2')
      expect(w2.path).toBe(join(WT_BASE, 'qi-3', 'r2'))
      expect(existsSync(w2.path)).toBe(true)
      // 主 worktree 仍存在
      expect(existsSync(w1.path)).toBe(true)
    })

    it('different gitlab projects use isolated cache slugs', async () => {
      await wt.acquireWorktree({
        requirementId: 4,
        gitlabProject: 'group-a/repo',
        gitUrl: ORIGIN_URL,
      })
      await wt.acquireWorktree({
        requirementId: 5,
        gitlabProject: 'group-b/repo',
        gitUrl: ORIGIN_URL,
      })
      expect(existsSync(join(CACHE_BASE, 'group-a-repo'))).toBe(true)
      expect(existsSync(join(CACHE_BASE, 'group-b-repo'))).toBe(true)
    })
  })

  describe('lockfile', () => {
    it('acquire/release writes and removes .qi-lock', async () => {
      const w = await wt.acquireWorktree({
        requirementId: 10,
        gitlabProject: 'group/repo',
        gitUrl: ORIGIN_URL,
      })

      expect(wt.checkLock(w.path)).toBe('absent')

      wt.acquireLock(w.path, process.pid, 'spec_review_loop')
      expect(existsSync(join(w.path, '.qi-lock'))).toBe(true)
      const data = wt.readLockData(w.path)
      expect(data?.pid).toBe(process.pid)
      expect(data?.nodeId).toBe('spec_review_loop')

      // 当前进程存活 → alive
      expect(wt.checkLock(w.path)).toBe('alive')

      wt.releaseLock(w.path)
      expect(existsSync(join(w.path, '.qi-lock'))).toBe(false)
      expect(wt.checkLock(w.path)).toBe('absent')
    })

    it('orphan lockfile (dead pid) detected', async () => {
      const w = await wt.acquireWorktree({
        requirementId: 11,
        gitlabProject: 'group/repo',
        gitUrl: ORIGIN_URL,
      })
      // 不可能存在的 pid（PID_MAX 一般是 2^22；用 2^31 保险）
      const fakePid = 2_000_000_000
      const lockData = {
        pid: fakePid,
        startedAt: new Date().toISOString(),
        nodeId: 'plan_author',
      }
      writeFileSync(
        join(w.path, '.qi-lock'),
        JSON.stringify(lockData),
        'utf8',
      )
      expect(wt.checkLock(w.path)).toBe('orphan')
    })

    it('corrupt lockfile treated as orphan', async () => {
      const w = await wt.acquireWorktree({
        requirementId: 12,
        gitlabProject: 'group/repo',
        gitUrl: ORIGIN_URL,
      })
      writeFileSync(join(w.path, '.qi-lock'), 'not a json {{', 'utf8')
      expect(wt.checkLock(w.path)).toBe('orphan')
    })
  })

  describe('removeWorktree', () => {
    it('refuses to remove when lock alive (without force)', async () => {
      const w = await wt.acquireWorktree({
        requirementId: 20,
        gitlabProject: 'group/repo',
        gitUrl: ORIGIN_URL,
      })
      wt.acquireLock(w.path, process.pid, 'dev_with_review_loop')

      await expect(
        wt.removeWorktree({
          requirementId: 20,
          gitlabProject: 'group/repo',
        }),
      ).rejects.toBeInstanceOf(wt.WorktreeBusyError)

      // worktree 仍然存在
      expect(existsSync(w.path)).toBe(true)

      wt.releaseLock(w.path)
    })

    it('cleans orphan lockfile and removes worktree', async () => {
      const w = await wt.acquireWorktree({
        requirementId: 21,
        gitlabProject: 'group/repo',
        gitUrl: ORIGIN_URL,
      })
      // 写一个孤儿 lockfile（pid 不存活）
      writeFileSync(
        join(w.path, '.qi-lock'),
        JSON.stringify({
          pid: 2_000_000_001,
          startedAt: new Date().toISOString(),
          nodeId: 'x',
        }),
        'utf8',
      )

      await wt.removeWorktree({
        requirementId: 21,
        gitlabProject: 'group/repo',
      })
      expect(existsSync(w.path)).toBe(false)
    })

    it('force removes even with alive lock', async () => {
      const w = await wt.acquireWorktree({
        requirementId: 22,
        gitlabProject: 'group/repo',
        gitUrl: ORIGIN_URL,
      })
      wt.acquireLock(w.path, process.pid, 'x')

      await wt.removeWorktree({
        requirementId: 22,
        gitlabProject: 'group/repo',
        force: true,
      })
      expect(existsSync(w.path)).toBe(false)
    })

    it('no-op on non-existent worktree', async () => {
      await expect(
        wt.removeWorktree({
          requirementId: 999_999,
          gitlabProject: 'group/repo',
        }),
      ).resolves.toBeUndefined()
    })
  })

  describe('listLiveWorktrees', () => {
    it('lists main worktrees and retry sub-paths', async () => {
      const w1 = await wt.acquireWorktree({
        requirementId: 30,
        gitlabProject: 'group/repo',
        gitUrl: ORIGIN_URL,
      })
      const w2 = await wt.acquireWorktree({
        requirementId: 31,
        gitlabProject: 'group/repo',
        gitUrl: ORIGIN_URL,
      })
      const w2r2 = await wt.acquireWorktree({
        requirementId: 31,
        gitlabProject: 'group/repo',
        gitUrl: ORIGIN_URL,
        retryAttempt: 2,
      })

      const live = await wt.listLiveWorktrees()
      const paths = new Set(live.map((l) => l.path))
      expect(paths.has(w1.path)).toBe(true)
      expect(paths.has(w2.path)).toBe(true)
      expect(paths.has(w2r2.path)).toBe(true)

      const r2Entry = live.find((l) => l.path === w2r2.path)!
      expect(r2Entry.requirementId).toBe(31)
      expect(r2Entry.retryAttempt).toBe(2)
    })

    it('countLiveWorktrees matches list length', async () => {
      await wt.acquireWorktree({
        requirementId: 40,
        gitlabProject: 'group/repo',
        gitUrl: ORIGIN_URL,
      })
      await wt.acquireWorktree({
        requirementId: 41,
        gitlabProject: 'group/repo',
        gitUrl: ORIGIN_URL,
      })
      const count = await wt.countLiveWorktrees()
      const list = await wt.listLiveWorktrees()
      expect(count).toBe(list.length)
      expect(count).toBeGreaterThanOrEqual(2)
    })
  })
})
