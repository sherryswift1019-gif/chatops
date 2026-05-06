import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('child_process', () => ({ spawnSync: vi.fn(), execFile: vi.fn() }))
vi.mock('fs', () => ({
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}))
vi.mock('../../config/gitlab.js', () => ({
  resolveGitlabConfig: vi.fn().mockResolvedValue({
    url: 'https://code.paraview.cn',
    token: 'test-token',
    skipTlsVerify: false,
  }),
}))
vi.mock('../../db/repositories/e2e-specs.js', () => ({
  updateE2eSpecStatus: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../db/repositories/e2e-target-projects.js', () => ({
  getE2eTargetProject: vi.fn().mockResolvedValue({
    id: 'chatops',
    gitlabRepo: 'https://code.paraview.cn/chatops/chatops.git',
    workingDir: '/workspace/chatops',
  }),
  extractGitlabPath: (repo: string) => {
    try {
      return new URL(repo).pathname.replace(/^\//, '').replace(/\.git$/, '')
    } catch {
      return repo.replace(/\.git$/, '')
    }
  },
}))
vi.mock('../../e2e/pipeline-a/nodes/baseline-sandbox.js', () => ({
  getWorkspacePaths: () => ({ containerPath: '/workspace/chatops' }),
}))

import { spawnSync } from 'child_process'
import { resolveGitlabConfig } from '../../config/gitlab.js'
import { updateE2eSpecStatus } from '../../db/repositories/e2e-specs.js'
import { commitAndPrNode } from '../../e2e/pipeline-a/nodes/commit-pr.js'

const baseState = {
  specs: [
    {
      specId: 1n,
      specPath: 'docs/test-specs/login.md',
      title: 'Login',
      contentHash: 'abc',
      targetProjectId: 'chatops',
      scriptPath: 'tests/e2e/login.spec.ts',
      generatedContent: 'test("login", () => {})',
    },
  ],
  currentSpecIndex: 0,
  baseBranch: 'main',
  targetProjectId: 'chatops',
  specPaths: [],
  sandboxHandle: null,
  baselineAttempts: 1,
  lastBaselineResult: { specId: 1n, passed: true },
  completedSpecs: [],
  maxBaselineAttempts: 3,
  maxStaticCheckAttempts: 2,
  staticCheckAttempts: 0,
  lastError: null,
  staticCheckResult: null,
  diagnosisVerdict: null,
}

// commit-pr.ts 现在通过 gitlabApi (= fetch) 调 GitLab REST 创 MR。早期版本走的是
// `glab` CLI（spawnSync 输出 MR url），切换后这里 stub 全局 fetch 避免真出网。
function mockFetchOnce(response: { ok: boolean; status: number; bodyJson?: unknown; bodyText?: string }) {
  const text = response.bodyText ?? (response.bodyJson !== undefined ? JSON.stringify(response.bodyJson) : '')
  return {
    ok: response.ok,
    status: response.status,
    text: () => Promise.resolve(text),
  }
}

describe('commitAndPrNode', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('git + MR 命令全成功 → prUrl 返回且 completedSpecs 包含 pr_open 状态', async () => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as any) // git checkout -b
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as any) // git add
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as any) // git commit
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as any) // git push

    fetchMock.mockResolvedValueOnce(mockFetchOnce({
      ok: true,
      status: 201,
      bodyJson: {
        iid: 123,
        web_url: 'https://code.paraview.cn/chatops/chatops/-/merge_requests/123',
      },
    }))

    const result = await commitAndPrNode(baseState as any)

    expect(result.completedSpecs).toHaveLength(1)
    expect(result.completedSpecs![0].specId).toBe(1n)
    expect(result.completedSpecs![0].status).toBe('pr_open')
    expect(result.completedSpecs![0].prUrl).toContain('merge_requests/123')
    expect(result.baselineAttempts).toBe(0)
    expect(result.staticCheckAttempts).toBe(0)

    // 断言确实走了 REST API（method=POST，URL 含 /api/v4/.../merge_requests）
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/v4\/projects\/.+\/merge_requests$/),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'PRIVATE-TOKEN': 'test-token' }),
      }),
    )

    expect(vi.mocked(updateE2eSpecStatus)).toHaveBeenCalledWith(
      1n,
      'pr_open',
      expect.objectContaining({
        generatedPrUrl: expect.stringContaining('merge_requests'),
        generatedArtifactPath: 'tests/e2e/login.spec.ts',
      }),
    )
  })

  it('GitLab MR create 返回非 2xx → spec 标 baseline_failed', async () => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as any) // checkout
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as any) // add
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as any) // commit
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as any) // push

    fetchMock.mockResolvedValueOnce(mockFetchOnce({
      ok: false,
      status: 401,
      bodyText: '{"message":"401 Unauthorized"}',
    }))

    const result = await commitAndPrNode(baseState as any)

    expect(result.completedSpecs).toHaveLength(1)
    expect(result.completedSpecs![0].specId).toBe(1n)
    expect(result.completedSpecs![0].status).toBe('baseline_failed')
    expect(vi.mocked(updateE2eSpecStatus)).toHaveBeenCalledWith(1n, 'baseline_failed')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('git commit 失败 → spec 标 baseline_failed', async () => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as any) // git checkout -b
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as any) // git add
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'error: conflict' } as any) // git commit fails

    const result = await commitAndPrNode(baseState as any)

    expect(result.completedSpecs).toHaveLength(1)
    expect(result.completedSpecs![0].status).toBe('baseline_failed')
    expect(vi.mocked(updateE2eSpecStatus)).toHaveBeenCalledWith(1n, 'baseline_failed')
    // commit 失败应在调 fetch 之前 short-circuit
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('spec.scriptPath 为空 → 返回 baseline_failed', async () => {
    const stateNoScriptPath = {
      ...baseState,
      specs: [{ ...baseState.specs[0]!, scriptPath: undefined }],
    }

    const result = await commitAndPrNode(stateNoScriptPath as any)

    expect(result.completedSpecs).toHaveLength(1)
    expect(result.completedSpecs![0].status).toBe('baseline_failed')
  })

  it('spec.generatedContent 为空 → 返回 baseline_failed', async () => {
    const stateNoContent = {
      ...baseState,
      specs: [{ ...baseState.specs[0]!, generatedContent: undefined }],
    }

    const result = await commitAndPrNode(stateNoContent as any)

    expect(result.completedSpecs).toHaveLength(1)
    expect(result.completedSpecs![0].status).toBe('baseline_failed')
  })
})
