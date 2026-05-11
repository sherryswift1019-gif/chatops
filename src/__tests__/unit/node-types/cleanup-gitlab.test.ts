import { describe, it, expect, beforeEach, vi } from 'vitest'
import axios from 'axios'
import { getExecutor } from '../../../pipeline/node-types/registry.js'
import '../../../pipeline/node-types/cleanup.js'

vi.mock('axios')
vi.mock('../../../config/gitlab.js', () => ({
  resolveGitlabConfig: async () => ({ url: 'https://gitlab.test', token: 'tok' }),
}))

const mockedAxios = vi.mocked(axios)

describe('cleanup remote_branch (GitLab DELETE)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(axios.isAxiosError).mockImplementation((e: any) => Boolean(e?.isAxiosError))
  })

  it('deletes remote branch (200 / 204 success)', async () => {
    mockedAxios.delete = vi.fn().mockResolvedValue({ status: 204 })

    const exec = getExecutor('cleanup')
    const result = await exec!.execute(
      { targets: [{ kind: 'remote_branch', project: 'group/proj', branch: 'feat/qi-7' }] },
      { runId: 1, pipelineId: 1, nodeId: 'cleanup', triggerParams: {}, vars: {}, steps: {} },
    )

    const report = result.output.report as any
    expect(result.status).toBe('success')
    expect(report.cleaned).toHaveLength(1)
    expect(report.failed).toHaveLength(0)
    expect(mockedAxios.delete).toHaveBeenCalledWith(
      'https://gitlab.test/api/v4/projects/group%2Fproj/repository/branches/feat%2Fqi-7',
      expect.objectContaining({ headers: { 'PRIVATE-TOKEN': 'tok' } }),
    )
  })

  it('treats 404 as success (branch already gone)', async () => {
    mockedAxios.delete = vi.fn().mockRejectedValue({
      isAxiosError: true,
      response: { status: 404, data: { message: '404 Branch Not Found' } },
    })

    const exec = getExecutor('cleanup')
    const result = await exec!.execute(
      { targets: [{ kind: 'remote_branch', project: 'group/proj', branch: 'feat/qi-7' }] },
      { runId: 1, pipelineId: 1, nodeId: 'cleanup', triggerParams: {}, vars: {}, steps: {} },
    )

    const report = result.output.report as any
    expect(report.cleaned).toHaveLength(1)
    expect(report.failed).toHaveLength(0)
  })

  it('reports failure on 403 (no permission) — warn-continue', async () => {
    mockedAxios.delete = vi.fn().mockRejectedValue({
      isAxiosError: true,
      response: { status: 403, data: { message: '403 Forbidden' } },
    })

    const exec = getExecutor('cleanup')
    const result = await exec!.execute(
      { targets: [{ kind: 'remote_branch', project: 'group/proj', branch: 'feat/qi-7' }] },
      { runId: 1, pipelineId: 1, nodeId: 'cleanup', triggerParams: {}, vars: {}, steps: {} },
    )

    const report = result.output.report as any
    expect(result.status).toBe('success') // warn-continue
    expect(report.cleaned).toHaveLength(0)
    expect(report.failed).toHaveLength(1)
    expect(report.failed[0]).toMatchObject({
      kind: 'remote_branch',
      ok: false,
    })
    expect(report.failed[0].error).toMatch(/403/)
  })
})

describe('cleanup draft_mr (GitLab close)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(axios.isAxiosError).mockImplementation((e: any) => Boolean(e?.isAxiosError))
  })

  it('closes draft MR (PUT state_event=close)', async () => {
    mockedAxios.put = vi.fn().mockResolvedValue({ data: { iid: 42, state: 'closed' } })

    const exec = getExecutor('cleanup')
    const result = await exec!.execute(
      { targets: [{ kind: 'draft_mr', project: 'group/proj', mrIid: 42 }] },
      { runId: 1, pipelineId: 1, nodeId: 'cleanup', triggerParams: {}, vars: {}, steps: {} },
    )

    const report = result.output.report as any
    expect(report.cleaned).toHaveLength(1)
    expect(mockedAxios.put).toHaveBeenCalledWith(
      'https://gitlab.test/api/v4/projects/group%2Fproj/merge_requests/42',
      { state_event: 'close' },
      expect.objectContaining({ headers: { 'PRIVATE-TOKEN': 'tok' } }),
    )
  })

  it('treats 404 as success (MR already gone)', async () => {
    mockedAxios.put = vi.fn().mockRejectedValue({
      isAxiosError: true,
      response: { status: 404 },
    })

    const exec = getExecutor('cleanup')
    const result = await exec!.execute(
      { targets: [{ kind: 'draft_mr', project: 'group/proj', mrIid: 42 }] },
      { runId: 1, pipelineId: 1, nodeId: 'cleanup', triggerParams: {}, vars: {}, steps: {} },
    )

    const report = result.output.report as any
    expect(report.cleaned).toHaveLength(1)
  })

  it('skips when mrIid is 0 or invalid (no MR was created)', async () => {
    const exec = getExecutor('cleanup')
    const result = await exec!.execute(
      { targets: [{ kind: 'draft_mr', project: 'group/proj', mrIid: 0 }] },
      { runId: 1, pipelineId: 1, nodeId: 'cleanup', triggerParams: {}, vars: {}, steps: {} },
    )

    // mrIid=0 → 视为 no-MR-to-close，归入 cleaned 但加 skipped 标记
    const report = result.output.report as any
    expect(report.cleaned).toHaveLength(1)
    expect(report.cleaned[0]).toMatchObject({ kind: 'draft_mr', mrIid: 0, ok: true })
    expect(mockedAxios.put).not.toHaveBeenCalled()
  })
})
