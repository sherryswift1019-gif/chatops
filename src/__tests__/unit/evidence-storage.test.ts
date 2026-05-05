// src/__tests__/unit/evidence-storage.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('fs/promises', () => ({
  mkdir: vi.fn(),
  cp: vi.fn(),
  rm: vi.fn(),
}))

import { mkdir, cp, rm } from 'fs/promises'
import { persistEvidenceDir, getEvidenceRoot } from '../../e2e/pipeline-b/evidence/storage.js'

const DEFAULT_ROOT = '/var/chatops/e2e-evidence'

beforeEach(() => {
  vi.resetAllMocks()
  delete process.env.E2E_EVIDENCE_ROOT
  delete process.env.TEST_DATA_DIR
  vi.mocked(mkdir).mockResolvedValue(undefined)
  vi.mocked(cp).mockResolvedValue(undefined)
  vi.mocked(rm).mockResolvedValue(undefined)
})

describe('getEvidenceRoot', () => {
  it('无任何 env 时回落到 /var/chatops/e2e-evidence', () => {
    expect(getEvidenceRoot()).toBe('/var/chatops/e2e-evidence')
  })

  it('TEST_DATA_DIR 设置时用 $TEST_DATA_DIR/e2e-evidence', () => {
    process.env.TEST_DATA_DIR = '/data/chatops/test-runs'
    expect(getEvidenceRoot()).toBe('/data/chatops/test-runs/e2e-evidence')
  })

  it('E2E_EVIDENCE_ROOT 优先级最高，覆盖 TEST_DATA_DIR', () => {
    process.env.TEST_DATA_DIR = '/data/chatops/test-runs'
    process.env.E2E_EVIDENCE_ROOT = '/custom/evidence'
    expect(getEvidenceRoot()).toBe('/custom/evidence')
  })
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

  it('mkdir 以 persistedDir 父目录被调用（recursive: true）', async () => {
    await persistEvidenceDir({
      tempDir: '/tmp/evidence',
      runId: 1n,
      scenarioId: 'checkout',
      attemptNumber: 1,
    })

    // 父目录是 .../1/checkout，cp 会再创建 attempt 子目录
    expect(mkdir).toHaveBeenCalledWith(
      `${DEFAULT_ROOT}/1/checkout`,
      { recursive: true },
    )
  })

  it('cp 从 tempDir 递归拷到 persistedDir', async () => {
    await persistEvidenceDir({
      tempDir: '/tmp/evidence/checkout',
      runId: 1n,
      scenarioId: 'checkout',
      attemptNumber: 3,
    })

    expect(cp).toHaveBeenCalledWith(
      '/tmp/evidence/checkout',
      `${DEFAULT_ROOT}/1/checkout/3`,
      { recursive: true },
    )
  })

  it('rm 在 cp 成功后清掉 tempDir', async () => {
    await persistEvidenceDir({
      tempDir: '/tmp/evidence/abc',
      runId: 7n,
      scenarioId: 's1',
      attemptNumber: 1,
    })

    expect(rm).toHaveBeenCalledWith('/tmp/evidence/abc', { recursive: true, force: true })
  })

  it('mkdir 失败时 bubble up', async () => {
    vi.mocked(mkdir).mockRejectedValueOnce(new Error('EPERM'))
    await expect(
      persistEvidenceDir({ tempDir: '/tmp/e', runId: 1n, scenarioId: 's', attemptNumber: 1 }),
    ).rejects.toThrow('EPERM')
  })

  it('cp 失败时 bubble up（不会调 rm）', async () => {
    vi.mocked(cp).mockRejectedValueOnce(new Error('ENOSPC'))
    await expect(
      persistEvidenceDir({ tempDir: '/tmp/e', runId: 1n, scenarioId: 's', attemptNumber: 1 }),
    ).rejects.toThrow('ENOSPC')
    expect(rm).not.toHaveBeenCalled()
  })
})
