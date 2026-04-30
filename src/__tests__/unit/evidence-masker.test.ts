// src/__tests__/unit/evidence-masker.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../agent/masking/sensitive-info.js', () => ({
  mask: vi.fn((text: string) => text.replace(/secret/gi, '[MASKED]')),
}))

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}))

import { readFile, writeFile } from 'fs/promises'
import { mask } from '../../agent/masking/sensitive-info.js'
import { maskTextArtifacts } from '../../e2e/pipeline-b/evidence/masker.js'
import type { EvidenceManifest } from '../../e2e/pipeline-b/evidence/types.js'

const BASE_DIR = '/tmp/evidence/scenario-1'

const manifest: EvidenceManifest = {
  summary: 'login failed',
  contextHint: 'auth flow',
  artifacts: [
    { kind: 'stderr', module: null, mimeType: 'text/plain', path: 'artifacts/stderr-1.txt', description: 'stderr output' },
    { kind: 'log', module: 'auth-svc', mimeType: 'text/plain', path: 'artifacts/auth-svc.log', description: 'auth service log' },
    { kind: 'screenshot', module: null, mimeType: 'image/png', path: 'artifacts/fail-moment.png', description: 'failure screenshot' },
  ],
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(mask).mockImplementation((text: string) => text.replace(/secret/gi, '[MASKED]'))
  vi.mocked(readFile).mockResolvedValue('log line with secret token\n' as any)
  vi.mocked(writeFile).mockResolvedValue(undefined)
})

describe('maskTextArtifacts', () => {
  it('text/* artifact 被读取、mask 后写回', async () => {
    await maskTextArtifacts(BASE_DIR, manifest)

    expect(readFile).toHaveBeenCalledTimes(2)
    expect(readFile).toHaveBeenCalledWith(`${BASE_DIR}/artifacts/stderr-1.txt`, 'utf8')
    expect(readFile).toHaveBeenCalledWith(`${BASE_DIR}/artifacts/auth-svc.log`, 'utf8')

    expect(mask).toHaveBeenCalledTimes(2)

    expect(writeFile).toHaveBeenCalledTimes(2)
    expect(writeFile).toHaveBeenCalledWith(
      `${BASE_DIR}/artifacts/stderr-1.txt`,
      'log line with [MASKED] token\n',
      'utf8',
    )
  })

  it('image/png artifact 被跳过（不读不写）', async () => {
    await maskTextArtifacts(BASE_DIR, manifest)

    const readCalls = vi.mocked(readFile).mock.calls.map(c => c[0])
    expect(readCalls).not.toContain(`${BASE_DIR}/artifacts/fail-moment.png`)

    const writeCalls = vi.mocked(writeFile).mock.calls.map(c => c[0])
    expect(writeCalls).not.toContain(`${BASE_DIR}/artifacts/fail-moment.png`)
  })

  it('空 artifacts 列表 → 无 IO 调用', async () => {
    const emptyManifest: EvidenceManifest = { ...manifest, artifacts: [] }
    await maskTextArtifacts(BASE_DIR, emptyManifest)
    expect(readFile).not.toHaveBeenCalled()
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('readFile 抛错时 bubble up', async () => {
    vi.mocked(readFile).mockRejectedValueOnce(new Error('ENOENT'))
    await expect(maskTextArtifacts(BASE_DIR, manifest)).rejects.toThrow('ENOENT')
  })
})
