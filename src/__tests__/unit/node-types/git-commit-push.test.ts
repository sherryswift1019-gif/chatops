import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getExecutor } from '../../../pipeline/node-types/registry.js'

// Static import triggers self-registration; ESM module cache makes dynamic
// re-import a no-op, so __resetRegistryForTesting + beforeEach pattern fails
// on the 3rd test. Static import is the correct pattern (matches end/cleanup tests).
import '../../../pipeline/node-types/git-commit-push.js'

const exec = promisify(execFile)

async function makeGitRepo(): Promise<{ worktree: string; bare: string }> {
  const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'git-cp-bare-'))
  await exec('git', ['init', '--bare', bare])
  const worktree = await fs.mkdtemp(path.join(os.tmpdir(), 'git-cp-wt-'))
  await exec('git', ['clone', bare, worktree])
  // 让 worktree 有初始 commit
  await fs.writeFile(path.join(worktree, 'README.md'), 'init\n')
  await exec('git', ['-C', worktree, 'add', '.'])
  await exec('git', ['-C', worktree, 'config', 'user.email', 'test@example.com'])
  await exec('git', ['-C', worktree, 'config', 'user.name', 'test'])
  await exec('git', ['-C', worktree, 'commit', '-m', 'init'])
  await exec('git', ['-C', worktree, 'push', 'origin', 'master'])
  return { worktree, bare }
}

describe('git_commit_push node type', () => {
  it('commits and pushes a new file', async () => {
    const { worktree } = await makeGitRepo()
    await fs.writeFile(path.join(worktree, 'spec.md'), '# spec\n')

    const cp = getExecutor('git_commit_push')
    const result = await cp!.execute(
      {
        worktreePath: worktree,
        branch: 'master',
        artifactPaths: ['spec.md'],
        commitMessage: 'docs(qi-1): spec — test',
      },
      { runId: 1, pipelineId: 1, nodeId: 'spec_commit_push', triggerParams: {}, vars: {}, steps: {} },
    )

    expect(result.status).toBe('success')
    expect(result.output.commitSha).toMatch(/^[a-f0-9]{40}$/)
    expect(result.output.pushedAt).toBeTruthy()
  })

  it('is idempotent: re-running on same state returns success with skipped=true', async () => {
    const { worktree } = await makeGitRepo()
    await fs.writeFile(path.join(worktree, 'spec.md'), '# spec\n')

    const cp = getExecutor('git_commit_push')
    // 第一次
    await cp!.execute(
      { worktreePath: worktree, branch: 'master', artifactPaths: ['spec.md'], commitMessage: 'docs: spec' },
      { runId: 1, pipelineId: 1, nodeId: 'x', triggerParams: {}, vars: {}, steps: {} },
    )
    // 第二次重跑（无新改动）
    const r2 = await cp!.execute(
      { worktreePath: worktree, branch: 'master', artifactPaths: ['spec.md'], commitMessage: 'docs: spec' },
      { runId: 1, pipelineId: 1, nodeId: 'x', triggerParams: {}, vars: {}, steps: {} },
    )

    expect(r2.status).toBe('success')
    expect(r2.output.skipped).toBe(true)  // 无新改动跳过
  })

  it('fails clearly when worktreePath missing', async () => {
    const cp = getExecutor('git_commit_push')
    const result = await cp!.execute(
      { branch: 'master', artifactPaths: ['spec.md'], commitMessage: 'msg' },
      { runId: 1, pipelineId: 1, nodeId: 'x', triggerParams: {}, vars: {}, steps: {} },
    )
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/worktreePath/)
  })
})
