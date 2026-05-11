import { describe, it, expect, beforeEach, vi } from 'vitest'
import { getExecutor } from '../../../pipeline/node-types/registry.js'
import '../../../pipeline/node-types/init-qi-branch.js'

vi.mock('../../../db/repositories/requirements.js', async () => ({
  getRequirementById: vi.fn(),
  setBranchAndWorktree: vi.fn(),
  setRequirementStatus: vi.fn(),
}))
vi.mock('../../../config/gitlab.js', () => ({
  resolveGitlabConfig: async () => ({ url: 'https://gitlab.test', token: 'tok' }),
}))
vi.mock('../../../quick-impl/worktree.js', async () => ({
  acquireWorktree: vi.fn(),
  countLiveWorktrees: vi.fn(),
  WORKTREE_BASE_QI: '/tmp/quick-impl',
}))
vi.mock('../../../quick-impl/qi-bare-repo.js', () => ({
  ensureBareRepo: vi.fn(),
}))
vi.mock('../../../pipeline/git-helpers.js', () => ({
  gitPushBranch: vi.fn(),
  normalizeProjectPath: (s: string) => s,
  escapeShell: (s: string) => `'${s}'`,
}))
vi.mock('child_process', () => ({
  exec: vi.fn((cmd: string, _opts: any, cb: any) => cb(null, { stdout: '', stderr: '' })),
}))

const reqRepo = await import('../../../db/repositories/requirements.js')
const worktree = await import('../../../quick-impl/worktree.js')
const bareRepo = await import('../../../quick-impl/qi-bare-repo.js')
const helpers = await import('../../../pipeline/git-helpers.js')

describe('init_qi_branch early push to GitLab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(reqRepo.getRequirementById).mockResolvedValue({
      id: 7, title: 't', rawInput: 'x', status: 'queued',
      branch: null, baseBranch: 'main', gitlabProject: 'group/proj',
      worktreePath: null, mrUrl: null, specContent: null, planContent: null,
      pipelineRunId: 1, currentStage: null, specPath: null, planPath: null,
      abortReason: null, retryCounters: {}, source: 'web', createdBy: null,
      createdAt: new Date(), updatedAt: new Date(), completedAt: null,
    } as any)
    vi.mocked(worktree.countLiveWorktrees).mockResolvedValue(0)
    vi.mocked(worktree.acquireWorktree).mockResolvedValue({
      branch: 'feat/qi-7', path: '/tmp/quick-impl/qi-7', cachePath: '/cache/proj',
    } as any)
    vi.mocked(bareRepo.ensureBareRepo).mockResolvedValue('/tmp/bare/proj.git')
  })

  it('makes empty commit + push origin after worktree + bare repo', async () => {
    vi.mocked(helpers.gitPushBranch).mockResolvedValue(undefined)

    const exec = getExecutor('init_qi_branch')
    const result = await exec!.execute(
      { requirementId: 7 },
      { runId: 1, pipelineId: 1, nodeId: 'init_branch', triggerParams: {}, vars: {}, steps: {} },
    )

    expect(result.status).toBe('success')
    expect(result.output.remotePushed).toBe(true)
    expect(helpers.gitPushBranch).toHaveBeenCalledWith(
      '/tmp/quick-impl/qi-7',
      'feat/qi-7',
      'https://gitlab.test',
      'group/proj',
    )
  })

  it('warn-continue when push fails (network / auth) — status still success', async () => {
    vi.mocked(helpers.gitPushBranch).mockRejectedValue(new Error('Could not resolve host: gitlab.test'))

    const exec = getExecutor('init_qi_branch')
    const result = await exec!.execute(
      { requirementId: 7 },
      { runId: 1, pipelineId: 1, nodeId: 'init_branch', triggerParams: {}, vars: {}, steps: {} },
    )

    // node 自身依然 success（push 是 best-effort），但 output.remotePushed=false
    expect(result.status).toBe('success')
    expect(result.output.remotePushed).toBe(false)
    expect(result.output.pushError).toMatch(/Could not resolve host/)
  })

  it('makes commit with -c user.email/user.name to avoid global config dep', async () => {
    vi.mocked(helpers.gitPushBranch).mockResolvedValue(undefined)
    const cp = await import('child_process')
    const execMock = vi.mocked(cp.exec)

    const exec = getExecutor('init_qi_branch')
    await exec!.execute(
      { requirementId: 7 },
      { runId: 1, pipelineId: 1, nodeId: 'init_branch', triggerParams: {}, vars: {}, steps: {} },
    )

    // 找 commit --allow-empty 调用
    const commitCall = execMock.mock.calls.find(c =>
      typeof c[0] === 'string' && c[0].includes('commit --allow-empty')
    )
    expect(commitCall).toBeDefined()
    expect(commitCall![0]).toContain('-c user.email=')
    expect(commitCall![0]).toContain('-c user.name=')
    expect(commitCall![0]).toMatch(/chore\(qi-7\): init branch/)
  })
})
