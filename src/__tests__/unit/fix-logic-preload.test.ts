/**
 * 集成测试：runFixForProject 的非 Claude 路径。
 * 验证：调 preloadIssueToWorktree 写 .issue.md 到 worktree；prompt 引用 .issue.md 且不再硬编码根因/方案/影响模块。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../../agent/claude-cli.js', () => ({
  runClaudeCli: vi.fn(),
}))
vi.mock('../../agent/worktree/manager.js', () => ({
  acquire: vi.fn(),
  release: vi.fn(),
  makeWorktreeKey: vi.fn(() => 'test-key'),
}))
vi.mock('../../db/repositories/capabilities.js', () => ({
  getCapabilityByKey: vi.fn(),
}))
vi.mock('../../agent/analysis/gitlab-issue.js', () => ({
  gitlabGetIssue: vi.fn(),
}))
vi.mock('../../agent/fix/branch-manager.js', () => ({
  createFixBranch: vi.fn(),
  commitChanges: vi.fn(),
  rebaseOnTarget: vi.fn(),
  pushBranch: vi.fn(),
}))

import { runFixForProject } from '../../agent/fix/fix-logic.js'
import { runClaudeCli } from '../../agent/claude-cli.js'
import { acquire, release } from '../../agent/worktree/manager.js'
import { getCapabilityByKey } from '../../db/repositories/capabilities.js'
import { gitlabGetIssue } from '../../agent/analysis/gitlab-issue.js'
import { createFixBranch } from '../../agent/fix/branch-manager.js'

const baseInput = {
  reportId: 1,
  productLineId: 1,
  projectPath: 'PAM/foo',
  sourceBranch: 'main',
  affectedModules: ['x'],
  rootCauseSummary: '老字段，应不再被拼进 prompt',
  solutionsJson: [{ id: 'a', summary: 'fix', recommended: true, risk: 'low', effort: 'small' }],
  issueId: 42,
  confidence: 'high',
  level: 'l2',
  attempt: 1,
}

describe('runFixForProject: preload + prompt 集成行为', () => {
  let tmpDir: string

  beforeEach(async () => {
    vi.clearAllMocks()
    tmpDir = await mkdtemp(join(tmpdir(), 'fixlogic-test-'))
    vi.mocked(acquire).mockResolvedValue({
      path: tmpDir,
      userId: 'u', product: 'pl-1', version: 'main',
      sessionId: 's', expiresAt: new Date(),
    } as any)
    vi.mocked(release).mockResolvedValue(undefined as any)
    vi.mocked(createFixBranch).mockResolvedValue('fix/issue-42-1')
    vi.mocked(getCapabilityByKey).mockResolvedValue({
      id: 10,
      key: 'fix_bug_l2',
      toolNames: [],
      systemPrompt: '你是修复专家（测试 stub）',
    } as any)
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('调 gitlabGetIssue 并把描述写入 worktree/.issue.md', async () => {
    vi.mocked(gitlabGetIssue).mockResolvedValue({
      description: '## 根因\n\n某段根因\n\n## 方案\n\n- opt-a',
    })
    vi.mocked(runClaudeCli).mockResolvedValue('测试未通过')  // 让流程在 isFixSuccessful 后返回 failed，避开 commit/push

    await runFixForProject(baseInput)

    expect(vi.mocked(gitlabGetIssue)).toHaveBeenCalledWith('PAM/foo', 42)
    const issueBody = await fs.readFile(join(tmpDir, '.issue.md'), 'utf-8')
    expect(issueBody).toContain('## 根因')
    expect(issueBody).toContain('某段根因')
  })

  it('prompt 引用 .issue.md，不再拼根因/方案/影响模块的硬编码段', async () => {
    vi.mocked(gitlabGetIssue).mockResolvedValue({ description: 'x' })
    vi.mocked(runClaudeCli).mockResolvedValue('测试未通过')

    await runFixForProject(baseInput)

    expect(vi.mocked(runClaudeCli)).toHaveBeenCalled()
    const promptArg = (vi.mocked(runClaudeCli).mock.calls[0][0] as { prompt: string }).prompt
    // 新 prompt 引用了 .issue.md
    expect(promptArg).toContain('.issue.md')
    // 防止 regress 回老的 prompt 拼接方式
    expect(promptArg).not.toContain('## 根因分析')
    expect(promptArg).not.toContain('## 修复方案')
    expect(promptArg).not.toContain('## 影响模块')
    // 老字段不应出现在 prompt 里（Claude 应通过 .issue.md 读）
    expect(promptArg).not.toContain('老字段，应不再被拼进 prompt')
  })

  it('gitlabGetIssue 失败 → 返回 testPassed:false 带错误信息，不调 Claude', async () => {
    vi.mocked(gitlabGetIssue).mockRejectedValue(new Error('GitLab 500'))

    const result = await runFixForProject(baseInput)

    expect(result.testPassed).toBe(false)
    expect(result.error).toContain('#42')
    expect(result.error).toContain('GitLab 500')
    expect(vi.mocked(runClaudeCli)).not.toHaveBeenCalled()
  })
})
