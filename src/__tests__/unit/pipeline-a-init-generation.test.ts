import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../db/repositories/e2e-target-projects.js', () => ({
  getE2eTargetProject: vi.fn(),
}))

vi.mock('../../db/repositories/e2e-specs.js', () => ({
  upsertE2eSpec: vi.fn(),
  updateE2eSpecStatus: vi.fn(),
  listE2eSpecs: vi.fn(),
}))

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
}))

import { readFileSync } from 'fs'
import { getE2eTargetProject } from '../../db/repositories/e2e-target-projects.js'
import { upsertE2eSpec, updateE2eSpecStatus, listE2eSpecs } from '../../db/repositories/e2e-specs.js'
import { initGenerationNode } from '../../e2e/pipeline-a/nodes/init-generation.js'

const mockProject = { id: 1n, projectId: 'chatops', workingDir: '/app', capabilities: {}, scripts: {} }

const baseState = {
  targetProjectId: 'chatops',
  specPaths: [],
  baseBranch: 'main',
  specs: [],
  currentSpecIndex: 0,
  staticCheckAttempts: 0,
  maxStaticCheckAttempts: 2,
  sandboxHandle: null,
  baselineAttempts: 0,
  lastBaselineResult: null,
  completedSpecs: [],
  maxBaselineAttempts: 3,
  lastError: null,
  staticCheckResult: null,
  diagnosisVerdict: null,
}

function makeUpsertResult(specPath: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 1n,
    specPath,
    title: specPath.split('/').pop()?.replace('.md', '') ?? specPath,
    contentHash: 'unknown',
    ...overrides,
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(getE2eTargetProject).mockResolvedValue(mockProject as any)
  vi.mocked(updateE2eSpecStatus).mockResolvedValue(undefined as any)
})

describe('initGenerationNode', () => {
  it('specPaths 非空 → 直接用 specPaths，每条 spec 被 upsert 且状态改为 generating', async () => {
    const specPaths = ['docs/specs/feature-a/login.md', 'docs/specs/feature-a/signup.md']
    vi.mocked(readFileSync).mockImplementation(() => { throw new Error('ENOENT') })
    vi.mocked(upsertE2eSpec)
      .mockResolvedValueOnce(makeUpsertResult(specPaths[0]) as any)
      .mockResolvedValueOnce(makeUpsertResult(specPaths[1]) as any)

    const result = await initGenerationNode({ ...baseState, specPaths } as any)

    expect(result.specs).toHaveLength(2)
    expect(result.currentSpecIndex).toBe(0)
    expect(upsertE2eSpec).toHaveBeenCalledTimes(2)
    expect(updateE2eSpecStatus).toHaveBeenCalledTimes(2)
    expect(updateE2eSpecStatus).toHaveBeenCalledWith(1n, 'generating')
    expect(listE2eSpecs).not.toHaveBeenCalled()
  })

  it('specPaths 为空 → 从 listE2eSpecs 取 pending，过滤掉非 pending', async () => {
    vi.mocked(listE2eSpecs).mockResolvedValue([
      { specPath: 'docs/specs/a.md', generationStatus: 'pending' },
      { specPath: 'docs/specs/b.md', generationStatus: 'done' },
      { specPath: 'docs/specs/c.md', generationStatus: 'pending' },
    ] as any)
    vi.mocked(readFileSync).mockImplementation(() => { throw new Error('ENOENT') })
    vi.mocked(upsertE2eSpec)
      .mockResolvedValueOnce(makeUpsertResult('docs/specs/a.md') as any)
      .mockResolvedValueOnce(makeUpsertResult('docs/specs/c.md') as any)

    const result = await initGenerationNode({ ...baseState, specPaths: [] } as any)

    expect(listE2eSpecs).toHaveBeenCalledWith('chatops')
    expect(result.specs).toHaveLength(2)
    expect(upsertE2eSpec).toHaveBeenCalledTimes(2)
    const calledPaths = vi.mocked(upsertE2eSpec).mock.calls.map(c => c[0].specPath)
    expect(calledPaths).toContain('docs/specs/a.md')
    expect(calledPaths).toContain('docs/specs/c.md')
    expect(calledPaths).not.toContain('docs/specs/b.md')
  })

  it('文件存在时 → contentHash 是 16 位 hex 字符串（非 unknown）', async () => {
    const specPaths = ['docs/specs/feature-a/login.md']
    vi.mocked(readFileSync).mockReturnValue('spec content here' as any)
    vi.mocked(upsertE2eSpec).mockResolvedValue(makeUpsertResult(specPaths[0], { contentHash: 'aabbccdd11223344' }) as any)

    const result = await initGenerationNode({ ...baseState, specPaths } as any)

    const calledHash = vi.mocked(upsertE2eSpec).mock.calls[0][0].contentHash
    expect(calledHash).not.toBe('unknown')
    expect(calledHash).toMatch(/^[0-9a-f]{16}$/)
  })

  it('文件不存在时 → contentHash 是 unknown', async () => {
    const specPaths = ['docs/specs/remote-only.md']
    vi.mocked(readFileSync).mockImplementation(() => { throw new Error('ENOENT') })
    vi.mocked(upsertE2eSpec).mockResolvedValue(makeUpsertResult(specPaths[0]) as any)

    await initGenerationNode({ ...baseState, specPaths } as any)

    const calledHash = vi.mocked(upsertE2eSpec).mock.calls[0][0].contentHash
    expect(calledHash).toBe('unknown')
  })

  it('project 不存在 → throw Error', async () => {
    vi.mocked(getE2eTargetProject).mockResolvedValue(null as any)

    await expect(
      initGenerationNode({ ...baseState, specPaths: ['docs/specs/x.md'] } as any)
    ).rejects.toThrow(/chatops.*not found/)
  })
})
