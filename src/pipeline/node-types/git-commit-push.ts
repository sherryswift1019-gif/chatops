import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { registerNodeType } from './registry.js'
import type { NodeExecutionResult, ExecutionContext } from './types.js'

const execFileP = promisify(execFile)

async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileP('git', args, { cwd, maxBuffer: 50 * 1024 * 1024 })
  return { stdout: stdout.toString(), stderr: stderr.toString() }
}

/**
 * Merge feature branch into base branch with --no-ff, preserving all round commits.
 * Switches back to featureBranch after merge so callers can continue working on it.
 */
export async function runMergePreserveRounds(args: {
  worktreePath: string
  featureBranch: string
  baseBranch: string
  mergeMessage: string
}): Promise<void> {
  const { worktreePath, featureBranch, baseBranch, mergeMessage } = args
  await git(worktreePath, ['checkout', baseBranch])
  await git(worktreePath, ['merge', '--no-ff', featureBranch, '-m', mergeMessage])
  // Switch back to feature branch so caller state is unchanged
  await git(worktreePath, ['checkout', featureBranch])
}

async function hasChangesToCommit(worktreePath: string, artifactPaths: string[]): Promise<boolean> {
  if (artifactPaths.length === 0) return false
  const { stdout } = await git(worktreePath, ['status', '--porcelain', '--', ...artifactPaths])
  return stdout.trim().length > 0
}

async function isHeadAheadOfRemote(worktreePath: string, branch: string): Promise<boolean> {
  try {
    const { stdout } = await git(worktreePath, ['rev-list', '--count', `origin/${branch}..HEAD`])
    return Number(stdout.trim()) > 0
  } catch {
    // origin/<branch> 不存在视为 ahead（首次 push）
    return true
  }
}

registerNodeType({
  key: 'git_commit_push',
  async execute(
    params: Record<string, unknown>,
    _ctx: ExecutionContext,
  ): Promise<NodeExecutionResult> {
    const worktreePath = String(params.worktreePath ?? '')
    const branch = String(params.branch ?? '')
    const artifactPaths = (params.artifactPaths ?? []) as string[]
    const commitMessage = String(params.commitMessage ?? '')
    const pushOnly = params.pushOnly === true
    const mergeStrategy = params.mergeStrategy as string | undefined
    const baseBranch = params.baseBranch ? String(params.baseBranch) : undefined

    if (!worktreePath) return { status: 'failed', output: {}, error: 'git_commit_push: worktreePath required' }
    if (!branch)       return { status: 'failed', output: {}, error: 'git_commit_push: branch required' }
    if (!pushOnly && !commitMessage) {
      return { status: 'failed', output: {}, error: 'git_commit_push: commitMessage required (unless pushOnly)' }
    }
    if (mergeStrategy === 'preserve-rounds' && !baseBranch) {
      return { status: 'failed', output: {}, error: 'git_commit_push: baseBranch required when mergeStrategy=preserve-rounds' }
    }

    try {
      let didCommit = false

      if (!pushOnly) {
        const hasChanges = await hasChangesToCommit(worktreePath, artifactPaths)
        if (hasChanges) {
          await git(worktreePath, ['add', '--', ...artifactPaths])
          await git(worktreePath, ['commit', '-m', commitMessage])
          didCommit = true
        }
      }

      const commitSha = (await git(worktreePath, ['rev-parse', 'HEAD'])).stdout.trim()

      const needsPush = pushOnly ? true : await isHeadAheadOfRemote(worktreePath, branch)
      if (!needsPush && !didCommit) {
        return { status: 'success', output: { commitSha, skipped: true } }
      }

      await git(worktreePath, ['push', 'origin', `HEAD:${branch}`])

      if (mergeStrategy === 'preserve-rounds' && baseBranch) {
        // Pull base branch to get latest remote state, then merge --no-ff to preserve round commits
        await git(worktreePath, ['fetch', 'origin', baseBranch])
        await runMergePreserveRounds({
          worktreePath,
          featureBranch: branch,
          baseBranch,
          mergeMessage: commitMessage,
        })
        await git(worktreePath, ['push', 'origin', `HEAD:${baseBranch}`])
      }

      return {
        status: 'success',
        output: { commitSha, pushedAt: new Date().toISOString(), skipped: false },
      }
    } catch (err) {
      return {
        status: 'failed',
        output: {},
        error: `git_commit_push: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  },
})
