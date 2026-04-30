// src/__tests__/unit/evidence-storage.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('fs/promises', () => ({
  mkdir: vi.fn(),
  rename: vi.fn(),
}))

import { mkdir, rename } from 'fs/promises'
import { persistEvidenceDir } from '../../e2e/pipeline-b/evidence/storage.js'

const DEFAULT_ROOT = '/var/chatops/e2e-evidence'

beforeEach(() => {
  vi.resetAllMocks()
  delete process.env.E2E_EVIDENCE_ROOT
  vi.mocked(mkdir).mockResolvedValue(undefined)
  vi.mocked(rename).mockResolvedValue(undefined)
})

describe('persistEvidenceDir', () => {
  it('默认 root 路径正确', async () => {
    const result = await persistEvidenceDir({
      tempDir: '/tmp/e2e-evidence/scenario-login',
      runId: 42n,
      scenarioId: 'login',
      attemptNumber: 1,
    })

    expect(result.persistedDir).toBe(`${DEFAULT_ROOT}/42/login/1`)
    expect(result.evidenceDirUri).toBe('/admin/e2e-runs/42/evidence/login/1')
  })

  it('E2E_EVIDENCE_ROOT 环境变量覆盖默认 root', async () => {
    process.env.E2E_EVIDENCE_ROOT = '/custom/evidence'

    const result = await persistEvidenceDir({
      tempDir: '/tmp/e2e-evidence/scenario-login',
      runId: 5n,
      scenarioId: 'login',
      attemptNumber: 2,
    })

    expect(result.persistedDir).toBe('/custom/evidence/5/login/2')
    expect(result.evidenceDirUri).toBe('/admin/e2e-runs/5/evidence/login/2')
  })

  it('mkdir 以正确路径被调用（recursive: true）', async () => {
    await persistEvidenceDir({
      tempDir: '/tmp/evidence',
      runId: 1n,
      scenarioId: 'checkout',
      attemptNumber: 1,
    })

    expect(mkdir).toHaveBeenCalledWith(
      `${DEFAULT_ROOT}/1/checkout/1`,
      { recursive: true },
    )
  })

  it('rename 从 tempDir 到 persistedDir', async () => {
    await persistEvidenceDir({
      tempDir: '/tmp/evidence/checkout',
      runId: 1n,
      scenarioId: 'checkout',
      attemptNumber: 3,
    })

    expect(rename).toHaveBeenCalledWith(
      '/tmp/evidence/checkout',
      `${DEFAULT_ROOT}/1/checkout/3`,
    )
  })

  it('mkdir 失败时 bubble up', async () => {
    vi.mocked(mkdir).mockRejectedValueOnce(new Error('EPERM'))
    await expect(
      persistEvidenceDir({ tempDir: '/tmp/e', runId: 1n, scenarioId: 's', attemptNumber: 1 }),
    ).rejects.toThrow('EPERM')
  })

  it('rename 失败时 bubble up', async () => {
    vi.mocked(rename).mockRejectedValueOnce(new Error('EXDEV'))
    await expect(
      persistEvidenceDir({ tempDir: '/tmp/e', runId: 1n, scenarioId: 's', attemptNumber: 1 }),
    ).rejects.toThrow('EXDEV')
  })
})
