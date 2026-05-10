import { exec } from 'child_process'
import { promisify } from 'util'
import { registerNodeType } from './registry.js'
import type { ExecutionContext, NodeExecutionResult } from './types.js'
import {
  acquireWorktree,
  countLiveWorktrees,
  WORKTREE_BASE_QI,
} from '../../quick-impl/worktree.js'
import {
  getRequirementById,
  setBranchAndWorktree,
  setRequirementStatus,
} from '../../db/repositories/requirements.js'
import { resolveGitlabConfig } from '../../config/gitlab.js'
import { ensureBareRepo } from '../../quick-impl/qi-bare-repo.js'

const execAsync = promisify(exec)
const DEFAULT_MAX_LIVE_WORKTREES = 20

/**
 * init_qi_branch — Quick-Impl 流水线第一个节点。
 *
 * 1. 检查活跃 worktree 数量不超过 max_live_worktrees（来自 params 或默认 10）
 * 2. 调用 acquireWorktree() 创建 git worktree + 新分支
 * 3. 写回 requirements.branch / worktree_path
 * 4. 更新 requirements.status → 'spec_review'
 *
 * Output: { branch, worktreePath, cachePath }
 */
registerNodeType({
  key: 'init_qi_branch',
  async execute(
    params: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<NodeExecutionResult> {
    const requirementId = Number(
      params.requirementId ?? ctx.triggerParams?.requirementId,
    )
    if (!requirementId || isNaN(requirementId)) {
      return { status: 'failed', output: {}, error: 'init_qi_branch: requirementId is required' }
    }

    const req = await getRequirementById(requirementId)
    if (!req) {
      return { status: 'failed', output: {}, error: `init_qi_branch: requirement ${requirementId} not found` }
    }

    // Concurrency guard
    const maxLive = typeof params.maxLiveWorktrees === 'number'
      ? params.maxLiveWorktrees
      : DEFAULT_MAX_LIVE_WORKTREES
    const liveCount = await countLiveWorktrees()
    if (liveCount >= maxLive) {
      return {
        status: 'failed',
        output: { liveCount, maxLive, worktreeBase: WORKTREE_BASE_QI },
        error: `init_qi_branch: max_live_worktrees (${maxLive}) reached, currently ${liveCount} active`,
      }
    }

    // GitLab URL for constructing the git remote URL
    let gitlabProject = String(
      params.gitlabProject ?? ctx.triggerParams?.gitlabProject ?? req.gitlabProject,
    )
    const baseBranch = String(
      params.baseBranch ?? ctx.triggerParams?.baseBranch ?? req.baseBranch,
    )
    const retryAttempt = typeof params.retryAttempt === 'number'
      ? params.retryAttempt
      : undefined

    const { url: gitlabUrl } = await resolveGitlabConfig()
    if (!gitlabUrl) {
      return { status: 'failed', output: {}, error: 'init_qi_branch: missing GitLab URL' }
    }
    // If user accidentally passed a full URL instead of a path, strip the base
    const gitlabBase = gitlabUrl.replace(/\/$/, '')
    if (gitlabProject.startsWith('http://') || gitlabProject.startsWith('https://')) {
      try {
        const u = new URL(gitlabProject)
        gitlabProject = u.pathname.replace(/^\//, '').replace(/\.git$/, '')
      } catch { /* leave as-is, will fail at clone with a clear error */ }
    }
    const gitUrl = `${gitlabBase}/${gitlabProject}.git`

    let wt: Awaited<ReturnType<typeof acquireWorktree>>
    try {
      wt = await acquireWorktree({
        requirementId,
        gitlabProject,
        gitUrl,
        baseBranch,
        retryAttempt,
      })
    } catch (err) {
      return {
        status: 'failed',
        output: {},
        error: `init_qi_branch: acquireWorktree failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }

    // Persist branch + worktreePath to requirements
    await setBranchAndWorktree(requirementId, wt.branch, wt.path)
    await setRequirementStatus(requirementId, 'spec_review')

    // v9: 创建 per-project 本地 bare repo 当 QI sandbox provision 的 origin
    // （不污染 GitLab，e2e 全绿后 mr_create 才正式 push GitLab）
    let bareRepoPath: string | null = null
    try {
      bareRepoPath = await ensureBareRepo(gitlabProject)
      // 在 worktree 内配 qi-local remote，方便人工调试时 git 操作；
      // qi_e2e_runner 实际 push 用 explicit URL 不依赖此 remote 配置。
      await execAsync(
        `git -C ${wt.path} remote add qi-local ${bareRepoPath}`,
        { timeout: 10_000 },
      ).catch(() => {
        // remote 已存在 → 改 url
        return execAsync(
          `git -C ${wt.path} remote set-url qi-local ${bareRepoPath}`,
          { timeout: 10_000 },
        ).catch(() => undefined)
      })
    } catch (err) {
      console.warn(
        `[init_qi_branch] ensureBareRepo failed for ${gitlabProject} (non-fatal, qi_e2e_runner 入口会重试): ${(err as Error).message}`,
      )
    }

    return {
      status: 'success',
      output: {
        branch: wt.branch,
        worktreePath: wt.path,
        cachePath: wt.cachePath,
        bareRepoPath,
      },
    }
  },
})
