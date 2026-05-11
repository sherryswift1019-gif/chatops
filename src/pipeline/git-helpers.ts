import { exec } from 'child_process'
import { promisify } from 'util'
import { injectGitlabAuth } from '../config/git-auth.js'

const execAsync = promisify(exec)

/** Shell-quote a string for single-quote literal usage. */
export function escapeShell(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

/**
 * Normalize various GitLab project identifiers down to `group/repo` form.
 * Accepts: "https://host/group/repo.git", "group/repo.git", "/group/repo/", "group/repo"
 */
export function normalizeProjectPath(input: string): string {
  let s = input.trim().replace(/\.git$/i, '')
  const m = /^https?:\/\/[^/]+\/(.+)$/.exec(s)
  if (m) s = m[1]
  return s.replace(/^\/+|\/+$/g, '')
}

/**
 * Push current HEAD of `worktreePath` to `<gitlabUrl>/<project>.git` as `branch`.
 * Uses authed URL (inject token via injectGitlabAuth).
 * Throws on any push failure.
 */
export async function gitPushBranch(
  worktreePath: string,
  branch: string,
  gitlabUrl: string,
  gitlabProject: string,
): Promise<void> {
  const projectPath = normalizeProjectPath(gitlabProject)
  const rawUrl = `${gitlabUrl.replace(/\/$/, '')}/${projectPath}.git`
  const authedUrl = await injectGitlabAuth(rawUrl)
  await execAsync(
    `git push ${escapeShell(authedUrl)} HEAD:${escapeShell(branch)}`,
    { cwd: worktreePath, timeout: 60_000 },
  )
}
