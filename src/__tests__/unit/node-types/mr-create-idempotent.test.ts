import { describe, it, expect, beforeEach, vi } from 'vitest'
import axios from 'axios'
import { getExecutor } from '../../../pipeline/node-types/registry.js'
import '../../../pipeline/node-types/mr-create.js'

vi.mock('axios')
vi.mock('../../../db/repositories/requirements.js', async () => ({
  getRequirementById: vi.fn(),
  setMrUrl: vi.fn(),
  setRequirementStatus: vi.fn(),
  setSpecPlanContent: vi.fn(),
}))
vi.mock('../../../config/gitlab.js', () => ({
  resolveGitlabConfig: async () => ({ url: 'https://gitlab.test', token: 'tok' }),
}))
vi.mock('../../../pipeline/node-types/mr-create.js', async (importOriginal) => {
  return importOriginal()
})
vi.mock('../../../config/git-auth.js', () => ({
  injectGitlabAuth: async (url: string) => url,
}))

const reqRepo = await import('../../../db/repositories/requirements.js')
const mockedAxios = vi.mocked(axios)

// mock child_process exec (for gitPushBranch)
vi.mock('child_process', () => ({
  exec: vi.fn((_cmd: string, _opts: unknown, cb: (err: null, result: { stdout: string; stderr: string }) => void) => {
    cb(null, { stdout: '', stderr: '' })
  }),
}))

describe('mr_create idempotency', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(reqRepo.setMrUrl).mockResolvedValue(undefined)
    vi.mocked(reqRepo.setRequirementStatus).mockResolvedValue(true)
    vi.mocked(reqRepo.setSpecPlanContent).mockResolvedValue(undefined)
  })

  it('POST creates MR when mrUrl is null (existing behavior)', async () => {
    vi.mocked(reqRepo.getRequirementById).mockResolvedValue({
      id: 1, title: 't', rawInput: 'x', status: 'mr_pending',
      branch: 'feat/qi-1', baseBranch: 'main', gitlabProject: 'group/proj',
      worktreePath: '/tmp/wt', mrUrl: null,
      specContent: 'spec', planContent: null,
      pipelineRunId: 1, currentStage: null, specPath: null, planPath: null,
      abortReason: null, retryCounters: {}, source: 'web', createdBy: null,
      createdAt: new Date(), updatedAt: new Date(), completedAt: null,
    } as any)
    mockedAxios.post = vi.fn().mockResolvedValue({ data: { iid: 42, web_url: 'https://gitlab.test/group/proj/-/merge_requests/42' } })

    const exec = getExecutor('mr_create')
    const result = await exec!.execute(
      { requirementId: 1, titleTemplate: '[qi] {{requirement.title}}' },
      { runId: 1, pipelineId: 1, nodeId: 'mr_create', triggerParams: {}, vars: {}, steps: {} },
    )

    expect(result.status).toBe('success')
    expect(result.output.created).toBe(true)
    expect(result.output.mrIid).toBe(42)
    expect(mockedAxios.post).toHaveBeenCalledTimes(1)
  })

  it('PUT updates MR when mrUrl already exists', async () => {
    vi.mocked(reqRepo.getRequirementById).mockResolvedValue({
      id: 1, title: 't', rawInput: 'x', status: 'mr_open',
      branch: 'feat/qi-1', baseBranch: 'main', gitlabProject: 'group/proj',
      worktreePath: '/tmp/wt', mrUrl: 'https://gitlab.test/group/proj/-/merge_requests/42',
      specContent: 'spec', planContent: null,
      pipelineRunId: 1, currentStage: null, specPath: null, planPath: null,
      abortReason: null, retryCounters: {}, source: 'web', createdBy: null,
      createdAt: new Date(), updatedAt: new Date(), completedAt: null,
    } as any)
    mockedAxios.put = vi.fn().mockResolvedValue({ data: { iid: 42, web_url: 'https://gitlab.test/group/proj/-/merge_requests/42' } })

    const exec = getExecutor('mr_create')
    const result = await exec!.execute(
      { requirementId: 1, titleTemplate: '[qi] {{requirement.title}}' },
      { runId: 1, pipelineId: 1, nodeId: 'mr_create', triggerParams: {}, vars: {}, steps: {} },
    )

    expect(result.status).toBe('success')
    expect(result.output.created).toBe(false)
    expect(result.output.mrIid).toBe(42)
    expect(mockedAxios.put).toHaveBeenCalledTimes(1)
    expect((mockedAxios.put as any).mock.calls[0][0]).toMatch(/\/merge_requests\/42$/)
  })

  it('POST 409 falls back to PUT (defensive idempotency)', async () => {
    vi.mocked(reqRepo.getRequirementById).mockResolvedValue({
      id: 1, title: 't', rawInput: 'x', status: 'mr_pending',
      branch: 'feat/qi-1', baseBranch: 'main', gitlabProject: 'group/proj',
      worktreePath: '/tmp/wt', mrUrl: null,
      specContent: 'spec', planContent: null,
      pipelineRunId: 1, currentStage: null, specPath: null, planPath: null,
      abortReason: null, retryCounters: {}, source: 'web', createdBy: null,
      createdAt: new Date(), updatedAt: new Date(), completedAt: null,
    } as any)

    // POST 409 with existing MR info in response.data
    const err409 = Object.assign(new Error('Conflict'), {
      isAxiosError: true,
      response: { status: 409, data: { message: 'Another open merge request already exists' } },
    })
    mockedAxios.post = vi.fn().mockRejectedValue(err409)
    // 409 后查 MR by source_branch
    mockedAxios.get = vi.fn().mockResolvedValue({ data: [{ iid: 99, web_url: 'https://gitlab.test/group/proj/-/merge_requests/99', state: 'opened' }] })
    mockedAxios.put = vi.fn().mockResolvedValue({ data: { iid: 99, web_url: 'https://gitlab.test/group/proj/-/merge_requests/99' } })
    vi.mocked(axios.isAxiosError).mockReturnValue(true)

    const exec = getExecutor('mr_create')
    const result = await exec!.execute(
      { requirementId: 1 },
      { runId: 1, pipelineId: 1, nodeId: 'mr_create', triggerParams: {}, vars: {}, steps: {} },
    )

    expect(result.status).toBe('success')
    expect(result.output.created).toBe(false)
    expect(result.output.mrIid).toBe(99)
    expect(mockedAxios.put).toHaveBeenCalled()
  })
})
