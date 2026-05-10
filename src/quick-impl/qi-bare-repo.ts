/**
 * Quick-Impl Local Bare Repo Manager
 *
 * 设计：docs/prds/prd-quick-impl-e2e-phase2.md - "QI 本地 bare repo 工具"
 *
 * QI 不直接 push 业务分支到 GitLab：dev-loop commit 后通过本地 bare repo 当伪 origin
 * 给 sandbox 的 deploy.sh provision 拉代码。e2e 全绿后 mr_create 才正式 push GitLab。
 *
 * 共享策略：per-project（同一 gitlabProject 的所有 QI run 共用一个 bare repo，
 * 按 feat/qi-{requirementId} 分支隔离，天然不冲突）。
 *
 * 与 [src/quick-impl/worktree.ts](worktree.ts) 的 cache repo（~/.chatops-repos-qi/）刻意分离：
 *   - cache repo: 加速 worktree clone，git origin 是 GitLab
 *   - bare repo (本文件): 给 sandbox 当 origin，不经 GitLab
 */
import { exec } from 'child_process'
import { existsSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { promisify } from 'util'

const execAsync = promisify(exec)

export const QI_LOCAL_REMOTE_BASE =
  process.env.QI_LOCAL_REMOTE_BASE ?? join(homedir(), '.chatops-repos-qi-bare')

function projectSlug(gitlabProject: string): string {
  return gitlabProject.replace(/\//g, '-')
}

function buildBareRepoPath(gitlabProject: string): string {
  return join(QI_LOCAL_REMOTE_BASE, `${projectSlug(gitlabProject)}.git`)
}

function validateBranchName(branch: string): void {
  if (!/^[a-zA-Z0-9_./-]+$/.test(branch)) {
    throw new Error(`[qi-bare-repo] invalid branch name: ${branch}`)
  }
}

async function runGit(cmd: string, cwd?: string): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execAsync(cmd, { cwd, timeout: 60_000 })
  return { stdout, stderr }
}

/**
 * 幂等创建 per-project 本地 bare repo。返回 bare 路径。
 *
 * - 首次：mkdir + `git init --bare`
 * - 已存在（含 HEAD 文件）：直接返回路径
 * - 部分初始化（有目录无 HEAD，可能上次失败留下的）：重新 init
 */
export async function ensureBareRepo(gitlabProject: string): Promise<string> {
  const bareRepoPath = buildBareRepoPath(gitlabProject)

  if (existsSync(join(bareRepoPath, 'HEAD'))) {
    return bareRepoPath
  }

  mkdirSync(bareRepoPath, { recursive: true })
  await runGit(`git init --bare`, bareRepoPath)
  return bareRepoPath
}

/**
 * 把 worktree 当前分支 push 到本地 bare 仓。
 *
 * 用普通 push（fast-forward）：dev-loop commit 是线性追加（不 rebase/amend），
 * 同分支重 push 自然 fast-forward。极少数 QI run restart 场景下分支历史可能分叉，
 * 但 schema-v62 设计是 abort/restart 走 ref 清理 + 新分支，不会撞既有分支。
 */
export async function pushToBare(
  worktreePath: string,
  branch: string,
  bareRepoPath: string,
): Promise<void> {
  validateBranchName(branch)

  if (!existsSync(worktreePath)) {
    throw new Error(`[qi-bare-repo] worktree not found: ${worktreePath}`)
  }
  if (!existsSync(join(bareRepoPath, 'HEAD'))) {
    throw new Error(`[qi-bare-repo] bare repo not initialized: ${bareRepoPath}`)
  }

  // 把 bare 路径作为 explicit remote URL（不依赖 worktree 的 git remote 配置，
  // 这样调用方不必先 git remote add）。
  await runGit(
    `git push ${bareRepoPath} ${branch}:${branch}`,
    worktreePath,
  )
}

/**
 * 删除 bare repo 里某个分支 ref。bare repo 目录本身保留（per-project 共享）。
 *
 * 用于 QI run 终态后清理：避免孤儿分支堆积导致 `git ls-remote` 输出膨胀。
 * 分支不存在时静默跳过（已被清过 / 从未推过）。
 */
export async function removeBareBranch(
  bareRepoPath: string,
  branch: string,
): Promise<void> {
  validateBranchName(branch)

  if (!existsSync(join(bareRepoPath, 'HEAD'))) {
    return
  }

  // bare repo 里 `git branch -D` 同样有效；不存在的 ref 退出非 0，吞掉。
  await runGit(`git branch -D ${branch}`, bareRepoPath).catch(() => {})
}

/**
 * 列出 bare repo 里现有分支（去掉前缀的 ref）。给 cleanup tick 反查用。
 */
export async function listBareBranches(bareRepoPath: string): Promise<string[]> {
  if (!existsSync(join(bareRepoPath, 'HEAD'))) {
    return []
  }
  const { stdout } = await runGit(
    `git for-each-ref --format='%(refname:short)' refs/heads/`,
    bareRepoPath,
  )
  return stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}
