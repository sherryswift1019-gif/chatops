import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export async function createFixBranch(cwd: string, issueId: number, attempt = 1): Promise<string> {
  const branch = attempt === 1
    ? `fix/issue-${issueId}`
    : `fix/issue-${issueId}-attempt-${attempt}`

  await execFileAsync('git', ['checkout', '-b', branch], { cwd, timeout: 30_000 })
  console.log(`[FixAgent] created branch: ${branch}`)
  return branch
}

export async function commitChanges(
  cwd: string,
  opts: {
    level: string
    issueTitle: string
    issueId: number
    attempt: number
    hypothesis: string
    changed: string
    testResult: string
    next: string
    confidence: string
  }
): Promise<void> {
  const message = [
    `fix(${opts.level}): ${opts.issueTitle} - attempt ${opts.attempt}/3`,
    '',
    `Hypothesis: ${opts.hypothesis}`,
    `Changed: ${opts.changed}`,
    `Test: ${opts.testResult}`,
    `Next: ${opts.next}`,
    '',
    `Issue: #${opts.issueId}`,
    `Confidence: ${opts.confidence}`,
  ].join('\n')

  await execFileAsync('git', ['add', '-A'], { cwd })
  await execFileAsync('git', ['commit', '-m', message], { cwd, timeout: 30_000 })
  console.log(`[FixAgent] committed: attempt ${opts.attempt}/3`)
}

export async function pushBranch(cwd: string, branch: string): Promise<void> {
  await execFileAsync('git', ['push', 'origin', branch], { cwd, timeout: 60_000 })
  console.log(`[FixAgent] pushed: ${branch}`)
}

/** Rebase 当前分支到目标分支最新，返回是否有冲突 */
export async function rebaseOnTarget(cwd: string, targetBranch: string): Promise<{ success: boolean; conflict: boolean }> {
  try {
    // 先 fetch 最新的目标分支
    await execFileAsync('git', ['fetch', 'origin', targetBranch], { cwd, timeout: 60_000 })
    // 尝试 rebase
    await execFileAsync('git', ['rebase', `origin/${targetBranch}`], { cwd, timeout: 120_000 })
    console.log(`[FixAgent] rebase on origin/${targetBranch} 成功`)
    return { success: true, conflict: false }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('CONFLICT') || msg.includes('could not apply')) {
      // 冲突 → 中止 rebase
      await execFileAsync('git', ['rebase', '--abort'], { cwd, timeout: 10_000 }).catch(() => {})
      console.warn(`[FixAgent] rebase 冲突，已中止`)
      return { success: false, conflict: true }
    }
    console.error(`[FixAgent] rebase 失败:`, msg)
    return { success: false, conflict: false }
  }
}
