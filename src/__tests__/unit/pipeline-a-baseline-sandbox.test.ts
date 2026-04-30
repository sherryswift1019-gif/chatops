// src/__tests__/unit/pipeline-a-baseline-sandbox.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('child_process', () => ({ spawnSync: vi.fn() }))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, readFileSync: vi.fn(), writeFileSync: vi.fn() }
})
vi.mock('../../../db/repositories/e2e-sandboxes.js', () => ({
  createSandbox: vi.fn().mockResolvedValue({ id: 1n, status: 'provisioning', handle: {} }),
  updateSandboxStatus: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../db/repositories/e2e-target-projects.js', () => ({
  getE2eTargetProject: vi.fn().mockResolvedValue({
    id: 'chatops', scripts: { deploy: 'deploy.sh', build: 'build.sh', test: 'test.sh' }, workingDir: '.',
  }),
}))

import { spawnSync } from 'child_process'
import { readFileSync } from 'fs'
import { setupBaselineSandboxNode } from '../../e2e/pipeline-a/nodes/baseline-sandbox.js'

const baseState = {
  specs: [{ specId: 1n, targetProjectId: 'chatops', specPath: 's.md', title: 'S', contentHash: 'x' }],
  currentSpecIndex: 0, baseBranch: 'main', targetProjectId: 'chatops',
  specPaths: [], sandboxHandle: null, baselineAttempts: 0, lastBaselineResult: null,
  completedSpecs: [], maxBaselineAttempts: 3, maxStaticCheckAttempts: 2,
  staticCheckAttempts: 0, lastError: null, staticCheckResult: null, diagnosisVerdict: null,
}

const HANDLE_JSON = '{"envId":"test-1","kind":"docker-compose-local","endpoints":{"api":"http://localhost:13001"},"internalRefs":{}}'

describe('setupBaselineSandboxNode', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('provision 成功 → sandboxHandle 非空', async () => {
    vi.mocked(readFileSync).mockReturnValue(HANDLE_JSON as any)
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as any)
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as any)
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as any)
    const result = await setupBaselineSandboxNode(baseState as any)
    expect(result.sandboxHandle).not.toBeNull()
    expect(result.sandboxHandle?.envId).toBe('test-1')
  })

  it('provision 失败 → throws', async () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 1, stdout: '', stderr: 'docker error' } as any)
    await expect(setupBaselineSandboxNode(baseState as any)).rejects.toThrow('provision failed')
  })
})
