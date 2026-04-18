import { describe, it, expect, vi, beforeEach } from 'vitest'
import { listArtifacts, resolveArtifact } from '../../pipeline/artifact-resolver.js'
import type { ArtifactInput } from '../../pipeline/types.js'

const fetchMock = vi.fn()
beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

const SAMPLE = {
  files: [
    { name: 'PAM-Docker-develop.tar.gz', path: 'pam/deploy/PAM-Docker-develop.tar.gz', type: 'file', size: 100, mtime: 3000 },
    { name: 'PAM-Docker-6.7.0.10.tar.gz', path: 'pam/deploy/PAM-Docker-6.7.0.10.tar.gz', type: 'file', size: 200, mtime: 2000 },
    { name: 'PAM-Docker-dir',             path: 'pam/deploy/PAM-Docker-dir',             type: 'dir',  size: 0,   mtime: 1000 },
    { name: 'other.txt',                  path: 'pam/deploy/other.txt',                  type: 'file', size: 50,  mtime: 500 },
  ],
}

function mockOk(body: unknown): void {
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => body })
}

describe('listArtifacts', () => {
  it('fetches listUrl?json=true and filters by glob, excludes dirs', async () => {
    mockOk(SAMPLE)
    const files = await listArtifacts({
      listUrl: 'http://repo/pam/deploy',
      glob: 'PAM-Docker-*.tar.gz',
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'http://repo/pam/deploy?json=true',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(files.map(f => f.name)).toEqual([
      'PAM-Docker-develop.tar.gz',
      'PAM-Docker-6.7.0.10.tar.gz',
    ])
  })

  it('builds downloadUrl from listUrl origin + path', async () => {
    mockOk(SAMPLE)
    const files = await listArtifacts({ listUrl: 'http://repo/pam/deploy', glob: '*.tar.gz' })
    expect(files[0].downloadUrl).toBe('http://repo/pam/deploy/PAM-Docker-develop.tar.gz')
  })

  it('sorts by mtime desc', async () => {
    mockOk(SAMPLE)
    const files = await listArtifacts({ listUrl: 'http://repo/pam/deploy', glob: '*.tar.gz' })
    expect(files[0].mtime).toBeGreaterThan(files[1].mtime)
  })

  it('throws ARTIFACT_REPO_UNREACHABLE on network error', async () => {
    fetchMock.mockRejectedValue(new Error('boom'))
    await expect(
      listArtifacts({ listUrl: 'http://repo/pam/deploy', glob: '*' }),
    ).rejects.toThrow(/ARTIFACT_REPO_UNREACHABLE/)
  })

  it('throws ARTIFACT_REPO_UNREACHABLE on non-2xx', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) })
    await expect(
      listArtifacts({ listUrl: 'http://repo', glob: '*' }),
    ).rejects.toThrow(/ARTIFACT_REPO_UNREACHABLE/)
  })
})

describe('resolveArtifact', () => {
  const base: ArtifactInput = {
    name: 't', listUrl: 'http://repo/pam/deploy',
    glob: 'PAM-Docker-*.tar.gz', outputVar: 'PACKAGE_URL', valueFrom: 'url',
  }

  it('uses providedRuntimeVar when given', async () => {
    const v = await resolveArtifact(base, 'http://override')
    expect(v).toBe('http://override')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uses default when no runtimeVar', async () => {
    const v = await resolveArtifact({ ...base, default: 'http://defaulted' }, undefined)
    expect(v).toBe('http://defaulted')
  })

  it('defaultStrategy latest-by-mtime picks newest', async () => {
    mockOk(SAMPLE)
    const v = await resolveArtifact({ ...base, defaultStrategy: 'latest-by-mtime' }, undefined)
    expect(v).toBe('http://repo/pam/deploy/PAM-Docker-develop.tar.gz')
  })

  it('defaultStrategy first-match picks lex-sorted first', async () => {
    mockOk(SAMPLE)
    const v = await resolveArtifact({ ...base, defaultStrategy: 'first-match' }, undefined)
    expect(v).toBe('http://repo/pam/deploy/PAM-Docker-6.7.0.10.tar.gz')
  })

  it('valueFrom=name returns file name', async () => {
    mockOk(SAMPLE)
    const v = await resolveArtifact(
      { ...base, valueFrom: 'name', defaultStrategy: 'latest-by-mtime' },
      undefined,
    )
    expect(v).toBe('PAM-Docker-develop.tar.gz')
  })

  it('throws ARTIFACT_INPUT_UNRESOLVED when no runtimeVar / default / strategy', async () => {
    await expect(resolveArtifact(base, undefined)).rejects.toThrow(/ARTIFACT_INPUT_UNRESOLVED/)
  })

  it('strategy finds nothing → ARTIFACT_NO_MATCH', async () => {
    mockOk({ files: [{ name: 'other.txt', path: 'x', type: 'file', size: 1, mtime: 1 }] })
    await expect(
      resolveArtifact({ ...base, defaultStrategy: 'latest-by-mtime' }, undefined),
    ).rejects.toThrow(/ARTIFACT_NO_MATCH/)
  })
})
