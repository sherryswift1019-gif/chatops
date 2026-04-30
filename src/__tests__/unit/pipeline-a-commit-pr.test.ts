import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('child_process', () => ({ spawnSync: vi.fn() }))
vi.mock('fs', () => ({
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}))
vi.mock('../../config/gitlab.js', () => ({
  resolveGitlabConfig: vi.fn().mockResolvedValue({
    url: 'https://gitlab.example.com',
    token: 'test-token',
    skipTlsVerify: false,
  }),
}))
vi.mock('../../db/repositories/e2e-specs.js', () => ({
  updateE2eSpecStatus: vi.fn().mockResolvedValue(undefined),
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

describe('commitAndPrNode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('git + MR 命令全成功 → prUrl 返回且 completedSpecs 包含 pr_open 状态', async () => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as any) // git checkout -b
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as any) // git add
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as any) // git commit
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as any) // git push
      .mockReturnValueOnce({
        status: 0,
        stdout: 'https://gitlab.example.com/chatops/chatops/-/merge_requests/123\n',
        stderr: '',
      } as any) // glab mr create

    const result = await commitAndPrNode(baseState as any)

    expect(result.completedSpecs).toHaveLength(1)
    expect(result.completedSpecs![0].specId).toBe(1n)
    expect(result.completedSpecs![0].status).toBe('pr_open')
    expect(result.completedSpecs![0].prUrl).toContain('merge_requests')
    expect(result.currentSpecIndex).toBe(1)
    expect(result.baselineAttempts).toBe(0)
    expect(result.staticCheckAttempts).toBe(0)

    expect(vi.mocked(updateE2eSpecStatus)).toHaveBeenCalledWith(
      1n,
      'pr_open',
      expect.objectContaining({
        generatedPrUrl: expect.stringContaining('merge_requests'),
        generatedArtifactPath: 'tests/e2e/login.spec.ts',
      }),
    )
  })

  it('glab mr create 失败 → spec 标 baseline_failed', async () => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as any)
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as any)
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as any)
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as any)
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'glab: unauthorized' } as any)

    const result = await commitAndPrNode(baseState as any)

    expect(result.completedSpecs).toHaveLength(1)
    expect(result.completedSpecs![0].specId).toBe(1n)
    expect(result.completedSpecs![0].status).toBe('baseline_failed')

    expect(vi.mocked(updateE2eSpecStatus)).toHaveBeenCalledWith(1n, 'baseline_failed')
  })

  it('git commit 失败 → spec 标 baseline_failed', async () => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as any) // git checkout -b
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as any) // git add
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'error: conflict' } as any) // git commit fails
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as any) // git push (not called but mocked for safety)

    const result = await commitAndPrNode(baseState as any)

    expect(result.completedSpecs).toHaveLength(1)
    expect(result.completedSpecs![0].status).toBe('baseline_failed')
    expect(vi.mocked(updateE2eSpecStatus)).toHaveBeenCalledWith(1n, 'baseline_failed')
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
