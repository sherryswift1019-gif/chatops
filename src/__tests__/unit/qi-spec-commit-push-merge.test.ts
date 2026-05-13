import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execSync } from 'child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { runMergePreserveRounds } from '../../pipeline/node-types/git-commit-push.js'

describe('spec_commit_push merge --no-ff preserve-rounds strategy', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'qi-merge-'))
    execSync(`git init -b main -q`, { cwd: repo })
    execSync(`git config user.email "test@test.com"`, { cwd: repo })
    execSync(`git config user.name "Test"`, { cwd: repo })
    execSync(`git commit --allow-empty -q -m "init"`, { cwd: repo })
    execSync(`git checkout -b qi-1 -q`, { cwd: repo })
    mkdirSync(join(repo, 'docs/specs'), { recursive: true })
    writeFileSync(join(repo, 'docs/specs/qi-1.md'), '# round 1')
    execSync(`git add . && git commit -q -m "docs(qi-1): spec round 1"`, { cwd: repo })
    writeFileSync(join(repo, 'docs/specs/qi-1.md'), '# round 2')
    execSync(`git add . && git commit -q -m "docs(qi-1): spec round 2"`, { cwd: repo })
  })

  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  it('merge --no-ff preserves round commits + adds a merge commit', async () => {
    await runMergePreserveRounds({
      worktreePath: repo,
      featureBranch: 'qi-1',
      baseBranch: 'main',
      mergeMessage: 'feat(qi-1): spec — login page (2 rounds)',
    })

    const log = execSync(`git log main --oneline`, { cwd: repo }).toString()
    expect(log).toMatch(/spec round 1/)
    expect(log).toMatch(/spec round 2/)
    expect(log).toMatch(/spec — login page/)
  })

  it('switches back to feature branch after merge', async () => {
    await runMergePreserveRounds({
      worktreePath: repo,
      featureBranch: 'qi-1',
      baseBranch: 'main',
      mergeMessage: 'feat(qi-1): spec — login page (2 rounds)',
    })

    const currentBranch = execSync(`git rev-parse --abbrev-ref HEAD`, { cwd: repo }).toString().trim()
    expect(currentBranch).toBe('qi-1')
  })

  it('creates a non-fast-forward merge commit on base branch', async () => {
    await runMergePreserveRounds({
      worktreePath: repo,
      featureBranch: 'qi-1',
      baseBranch: 'main',
      mergeMessage: 'feat(qi-1): spec — login page (2 rounds)',
    })

    // main should now have init + 2 round commits + 1 merge commit = 4 commits
    const count = execSync(`git rev-list --count main`, { cwd: repo }).toString().trim()
    expect(Number(count)).toBe(4)

    // The merge commit on main should have 2 parents (non-fast-forward)
    const parents = execSync(`git log main -1 --format="%P"`, { cwd: repo }).toString().trim()
    expect(parents.split(' ')).toHaveLength(2)
  })
})
