import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { exec } from 'child_process'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'

const execAsync = promisify(exec)

// 覆盖 env 后再 dynamic import，保证读到 env 覆盖后的常量
const TEST_BASE = mkdtempSync(join(tmpdir(), 'qi-bare-test-'))
const BARE_BASE = join(TEST_BASE, 'bare')
process.env.QI_LOCAL_REMOTE_BASE = BARE_BASE

const bareRepo = await import('../../quick-impl/qi-bare-repo.js')

async function makeWorkRepoWithCommit(branch: string): Promise<string> {
  const repoPath = mkdtempSync(join(TEST_BASE, 'work-'))
  await execAsync(`git init -b ${branch}`, { cwd: repoPath })
  await execAsync('git config user.email "t@t.t"', { cwd: repoPath })
  await execAsync('git config user.name "t"', { cwd: repoPath })
  writeFileSync(join(repoPath, 'README.md'), '# initial\n')
  await execAsync('git add README.md', { cwd: repoPath })
  await execAsync('git commit -m "init"', { cwd: repoPath })
  return repoPath
}

describe('qi-bare-repo', () => {
  afterAll(() => {
    rmSync(TEST_BASE, { recursive: true, force: true })
  })

  describe('ensureBareRepo', () => {
    it('首次创建 bare repo（含 HEAD 文件）', async () => {
      const path = await bareRepo.ensureBareRepo('group/repo-a')
      expect(path).toBe(join(BARE_BASE, 'group-repo-a.git'))
      expect(existsSync(join(path, 'HEAD'))).toBe(true)
      expect(existsSync(join(path, 'objects'))).toBe(true)
    })

    it('幂等：第二次返回同路径不报错', async () => {
      const p1 = await bareRepo.ensureBareRepo('group/repo-b')
      const p2 = await bareRepo.ensureBareRepo('group/repo-b')
      expect(p1).toBe(p2)
      expect(existsSync(join(p1, 'HEAD'))).toBe(true)
    })

    it('部分初始化（目录存在但 HEAD 缺失）→ 重新 init', async () => {
      const path = join(BARE_BASE, 'group-repo-c.git')
      mkdirSync(path, { recursive: true })
      // 不创建 HEAD
      const result = await bareRepo.ensureBareRepo('group/repo-c')
      expect(result).toBe(path)
      expect(existsSync(join(path, 'HEAD'))).toBe(true)
    })
  })

  describe('pushToBare', () => {
    it('push 到 fresh bare → bare 收到 ref', async () => {
      const bare = await bareRepo.ensureBareRepo('group/push-test')
      const work = await makeWorkRepoWithCommit('feat/qi-1')
      await bareRepo.pushToBare(work, 'feat/qi-1', bare)

      const branches = await bareRepo.listBareBranches(bare)
      expect(branches).toContain('feat/qi-1')
    })

    it('校验非法分支名', async () => {
      const bare = await bareRepo.ensureBareRepo('group/push-test-2')
      const work = await makeWorkRepoWithCommit('main')
      await expect(
        bareRepo.pushToBare(work, 'feat/qi 1; rm -rf /', bare),
      ).rejects.toThrow(/invalid branch name/)
    })

    it('worktree 不存在时报错', async () => {
      const bare = await bareRepo.ensureBareRepo('group/push-test-3')
      await expect(
        bareRepo.pushToBare(join(TEST_BASE, 'nonexistent'), 'feat/x', bare),
      ).rejects.toThrow(/worktree not found/)
    })

    it('bare 未初始化时报错', async () => {
      const work = await makeWorkRepoWithCommit('main')
      await expect(
        bareRepo.pushToBare(work, 'main', join(TEST_BASE, 'nonexistent.git')),
      ).rejects.toThrow(/bare repo not initialized/)
    })

    it('线性追加 commit 后再 push 成功', async () => {
      const bare = await bareRepo.ensureBareRepo('group/push-test-4')
      const work = await makeWorkRepoWithCommit('feat/qi-2')
      await bareRepo.pushToBare(work, 'feat/qi-2', bare)

      writeFileSync(join(work, 'foo.txt'), 'foo\n')
      await execAsync('git add foo.txt', { cwd: work })
      await execAsync('git commit -m "add foo"', { cwd: work })

      await bareRepo.pushToBare(work, 'feat/qi-2', bare)
      const branches = await bareRepo.listBareBranches(bare)
      expect(branches).toContain('feat/qi-2')
    })
  })

  describe('removeBareBranch', () => {
    it('删除已存在的分支', async () => {
      const bare = await bareRepo.ensureBareRepo('group/rm-test')
      const work = await makeWorkRepoWithCommit('feat/qi-99')
      await bareRepo.pushToBare(work, 'feat/qi-99', bare)

      let branches = await bareRepo.listBareBranches(bare)
      expect(branches).toContain('feat/qi-99')

      await bareRepo.removeBareBranch(bare, 'feat/qi-99')

      branches = await bareRepo.listBareBranches(bare)
      expect(branches).not.toContain('feat/qi-99')
    })

    it('分支不存在时静默通过', async () => {
      const bare = await bareRepo.ensureBareRepo('group/rm-test-2')
      await expect(
        bareRepo.removeBareBranch(bare, 'feat/qi-never'),
      ).resolves.toBeUndefined()
    })

    it('bare 路径不存在时静默通过（孤儿清理路径）', async () => {
      await expect(
        bareRepo.removeBareBranch(join(TEST_BASE, 'never.git'), 'feat/qi-x'),
      ).resolves.toBeUndefined()
    })

    it('校验非法分支名', async () => {
      const bare = await bareRepo.ensureBareRepo('group/rm-test-3')
      await expect(
        bareRepo.removeBareBranch(bare, '; rm -rf /'),
      ).rejects.toThrow(/invalid branch name/)
    })
  })

  describe('listBareBranches', () => {
    it('未初始化的 bare 返回空数组', async () => {
      const result = await bareRepo.listBareBranches(join(TEST_BASE, 'nonexistent.git'))
      expect(result).toEqual([])
    })

    it('多分支同 bare', async () => {
      const bare = await bareRepo.ensureBareRepo('group/list-test')
      const work1 = await makeWorkRepoWithCommit('feat/qi-1')
      await bareRepo.pushToBare(work1, 'feat/qi-1', bare)
      const work2 = await makeWorkRepoWithCommit('feat/qi-2')
      await bareRepo.pushToBare(work2, 'feat/qi-2', bare)

      const branches = await bareRepo.listBareBranches(bare)
      expect(branches.sort()).toEqual(['feat/qi-1', 'feat/qi-2'])
    })
  })
})
