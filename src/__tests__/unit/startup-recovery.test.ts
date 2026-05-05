// src/__tests__/unit/startup-recovery.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../db/repositories/e2e-runs.js', () => ({
  listInflightE2eRuns: vi.fn(),
  updateE2eRunStatus: vi.fn(),
}))

vi.mock('../../db/repositories/e2e-sandboxes.js', () => ({
  getSandboxByRunId: vi.fn(),
  updateSandboxStatus: vi.fn(),
}))

vi.mock('../../db/repositories/e2e-target-projects.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/repositories/e2e-target-projects.js')>()
  return {
    ...actual,
    getE2eTargetProject: vi.fn(),
  }
})

vi.mock('../../config/gitlab.js', () => ({
  resolveGitlabConfig: vi.fn(),
}))

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    writeFile: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
    mkdtemp: vi.fn().mockResolvedValue('/tmp/e2e-recovery-test'),
  }
})

vi.mock('../../e2e/pipeline-b/run-script.js', () => ({
  runScript: vi.fn(),
}))

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

import { recoverInflightE2eRuns } from '../../e2e/pipeline-b/startup-recovery.js'
import { listInflightE2eRuns, updateE2eRunStatus } from '../../db/repositories/e2e-runs.js'
import { getSandboxByRunId, updateSandboxStatus, type SandboxStatus } from '../../db/repositories/e2e-sandboxes.js'
import { getE2eTargetProject } from '../../db/repositories/e2e-target-projects.js'
import { resolveGitlabConfig } from '../../config/gitlab.js'
import { runScript } from '../../e2e/pipeline-b/run-script.js'
import * as fsPromises from 'fs/promises'

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(updateE2eRunStatus).mockResolvedValue(undefined)
  vi.mocked(updateSandboxStatus).mockResolvedValue(undefined)
  vi.mocked(resolveGitlabConfig).mockResolvedValue({ url: 'https://gitlab.example.com', token: 'tok', skipTlsVerify: false })
  vi.mocked(getE2eTargetProject).mockResolvedValue(null)
  vi.mocked(fsPromises.mkdtemp).mockResolvedValue('/tmp/e2e-recovery-test' as any)
  vi.mocked(fsPromises.writeFile).mockResolvedValue(undefined)
  vi.mocked(fsPromises.unlink).mockResolvedValue(undefined)
  vi.mocked(runScript).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', parsed: null })
  fetchMock.mockResolvedValue({ status: 204 })
})

function makeRun(id: bigint, iterationBranch = 'e2e/iter-abc123') {
  return {
    id,
    targetProjectId: 'group/repo',
    sourceBranch: 'main',
    iterationBranch,
    status: 'running' as const,
  }
}

function makeSandbox(id: bigint, runId: bigint, status: SandboxStatus = 'ready') {
  return {
    id,
    e2eRunId: runId,
    kind: 'compose',
    handle: { envId: 'env-1', kind: 'compose', endpoints: {} },
    status,
    createdAt: new Date(),
    readyAt: null,
    destroyedAt: null,
  }
}

describe('recoverInflightE2eRuns', () => {
  it('无 inflight runs → 函数正常退出', async () => {
    vi.mocked(listInflightE2eRuns).mockResolvedValue([])
    await expect(recoverInflightE2eRuns()).resolves.toBeUndefined()
    expect(updateE2eRunStatus).not.toHaveBeenCalled()
    expect(getSandboxByRunId).not.toHaveBeenCalled()
  })

  it('2 个 inflight runs → 全部标 aborted + teardown', async () => {
    const run1 = makeRun(1n, 'e2e/iter-aaa')
    const run2 = makeRun(2n, 'e2e/iter-bbb')
    vi.mocked(listInflightE2eRuns).mockResolvedValue([run1, run2] as any)
    vi.mocked(getSandboxByRunId).mockImplementation(async (runId) => {
      if (runId === 1n) return makeSandbox(10n, 1n, 'ready') as any
      if (runId === 2n) return makeSandbox(11n, 2n, 'provisioning') as any
      return null
    })

    await recoverInflightE2eRuns()

    expect(updateE2eRunStatus).toHaveBeenCalledWith(1n, 'aborted', { finishedAt: expect.any(Date), abortReason: 'process_restart' })
    expect(updateE2eRunStatus).toHaveBeenCalledWith(2n, 'aborted', { finishedAt: expect.any(Date), abortReason: 'process_restart' })
    expect(updateSandboxStatus).toHaveBeenCalledWith(10n, 'torn_down', expect.objectContaining({ destroyedAt: expect.any(Date) }))
    expect(updateSandboxStatus).toHaveBeenCalledWith(11n, 'torn_down', expect.objectContaining({ destroyedAt: expect.any(Date) }))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('teardown 失败 → 不抛异常，run 仍被标 aborted', async () => {
    vi.mocked(listInflightE2eRuns).mockResolvedValue([makeRun(3n, 'e2e/iter-ccc')] as any)
    vi.mocked(getSandboxByRunId).mockResolvedValue(makeSandbox(20n, 3n, 'ready') as any)
    vi.mocked(runScript).mockRejectedValue(new Error('docker teardown failed'))

    await expect(recoverInflightE2eRuns()).resolves.toBeUndefined()
    expect(updateE2eRunStatus).toHaveBeenCalledWith(3n, 'aborted', expect.any(Object))
  })

  it('delete branch 返回 404 → 算成功', async () => {
    vi.mocked(listInflightE2eRuns).mockResolvedValue([makeRun(4n, 'e2e/iter-ddd')] as any)
    vi.mocked(getSandboxByRunId).mockResolvedValue(null)
    fetchMock.mockResolvedValue({ status: 404 })

    await expect(recoverInflightE2eRuns()).resolves.toBeUndefined()
    expect(updateE2eRunStatus).toHaveBeenCalledWith(4n, 'aborted', expect.any(Object))
  })

  it('已是 torn_down 的沙盒 → 跳过 teardown', async () => {
    vi.mocked(listInflightE2eRuns).mockResolvedValue([makeRun(5n, 'e2e/iter-eee')] as any)
    vi.mocked(getSandboxByRunId).mockResolvedValue(makeSandbox(30n, 5n, 'torn_down') as any)

    await recoverInflightE2eRuns()
    expect(runScript).not.toHaveBeenCalled()
    expect(updateSandboxStatus).not.toHaveBeenCalled()
  })

  it('已是 failed 的沙盒 → 跳过 teardown', async () => {
    vi.mocked(listInflightE2eRuns).mockResolvedValue([makeRun(6n, 'e2e/iter-fff')] as any)
    vi.mocked(getSandboxByRunId).mockResolvedValue(makeSandbox(31n, 6n, 'failed') as any)

    await recoverInflightE2eRuns()
    expect(runScript).not.toHaveBeenCalled()
    expect(updateSandboxStatus).not.toHaveBeenCalled()
  })

  it('delete branch fetch 抛异常 → 不阻止 run 标 aborted', async () => {
    vi.mocked(listInflightE2eRuns).mockResolvedValue([makeRun(7n, 'e2e/iter-ggg')] as any)
    vi.mocked(getSandboxByRunId).mockResolvedValue(null)
    fetchMock.mockRejectedValue(new Error('network error'))

    await expect(recoverInflightE2eRuns()).resolves.toBeUndefined()
    expect(updateE2eRunStatus).toHaveBeenCalledWith(7n, 'aborted', expect.any(Object))
  })
})
