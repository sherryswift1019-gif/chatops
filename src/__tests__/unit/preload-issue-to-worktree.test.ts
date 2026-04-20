import { describe, it, expect, vi, beforeEach } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdtemp, rm } from 'fs/promises'

vi.mock('../../agent/analysis/gitlab-issue.js', () => ({
  gitlabGetIssue: vi.fn(),
}))

import { preloadIssueToWorktree } from '../../agent/fix/fix-logic.js'
import { gitlabGetIssue } from '../../agent/analysis/gitlab-issue.js'

describe('preloadIssueToWorktree', () => {
  let tmpDir: string

  beforeEach(async () => {
    vi.mocked(gitlabGetIssue).mockReset()
    tmpDir = await mkdtemp(join(tmpdir(), 'preload-test-'))
  })

  it('写入 Issue 描述到 worktree/.issue.md', async () => {
    vi.mocked(gitlabGetIssue).mockResolvedValue({
      description: '## 根因\n\nfoo\n\n## 方案\n\n- bar',
    })

    await preloadIssueToWorktree(tmpDir, 'PAM/pas-api', 42)

    const body = await fs.readFile(join(tmpDir, '.issue.md'), 'utf-8')
    expect(body).toContain('## 根因')
    expect(body).toContain('foo')
    expect(vi.mocked(gitlabGetIssue)).toHaveBeenCalledWith('PAM/pas-api', 42)

    await rm(tmpDir, { recursive: true, force: true })
  })

  it('gitlabGetIssue 抛错时向上抛出（不静默）', async () => {
    vi.mocked(gitlabGetIssue).mockRejectedValue(new Error('GitLab 404'))

    await expect(
      preloadIssueToWorktree(tmpDir, 'PAM/pas-api', 99),
    ).rejects.toThrow('GitLab 404')

    await rm(tmpDir, { recursive: true, force: true })
  })

  it('Issue description 为空字符串时，写入空文件（不崩）', async () => {
    vi.mocked(gitlabGetIssue).mockResolvedValue({ description: '' })

    await preloadIssueToWorktree(tmpDir, 'PAM/pas-api', 7)

    const body = await fs.readFile(join(tmpDir, '.issue.md'), 'utf-8')
    expect(body).toBe('')

    await rm(tmpDir, { recursive: true, force: true })
  })
})
