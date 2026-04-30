import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('child_process', () => ({ spawnSync: vi.fn() }))

vi.mock('../../db/repositories/e2e-target-projects.js', () => ({
  getE2eTargetProject: vi.fn(),
}))

vi.mock('../../e2e/pipeline-a/nodes/llm-generator.js', () => ({
  runE2eLlmGenerator: vi.fn().mockResolvedValue('// generated code'),
}))

import { spawnSync } from 'child_process'
import { getE2eTargetProject } from '../../db/repositories/e2e-target-projects.js'
import { runE2eLlmGenerator } from '../../e2e/pipeline-a/nodes/llm-generator.js'
import { generateOrSkipNode } from '../../e2e/pipeline-a/nodes/generate-or-skip.js'

const baseSpec = {
  specId: 1n,
  specPath: 'docs/specs/feature-a/login.md',
  title: 'login',
  contentHash: 'abc123',
  targetProjectId: 'chatops',
}

const baseState = {
  specs: [baseSpec],
  currentSpecIndex: 0,
  targetProjectId: 'chatops',
  specPaths: [],
  baseBranch: 'main',
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

function makeProject(generateCapable: boolean) {
  return {
    id: 1n,
    projectId: 'chatops',
    workingDir: '/app',
    capabilities: { generate: generateCapable },
    scripts: { test: 'scripts/test.sh' },
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(runE2eLlmGenerator).mockResolvedValue('// generated code')
})

describe('generateOrSkipNode', () => {
  it('generate=true + spawnSync 成功 → scriptPath 赋值，不调 LLM', async () => {
    vi.mocked(getE2eTargetProject).mockResolvedValue(makeProject(true) as any)
    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: '', stderr: '' } as any)

    const result = await generateOrSkipNode(baseState as any)

    expect(result.specs).toBeDefined()
    expect(result.specs![0].scriptPath).toBeDefined()
    expect(runE2eLlmGenerator).not.toHaveBeenCalled()
    // generate 成功时 staticCheckAttempts 不在返回值中
    expect(result.staticCheckAttempts).toBeUndefined()
  })

  it('generate=true + spawnSync 失败 → fallback 调 LLM，generatedContent 非空', async () => {
    vi.mocked(getE2eTargetProject).mockResolvedValue(makeProject(true) as any)
    vi.mocked(spawnSync).mockReturnValue({ status: 1, stdout: '', stderr: 'error' } as any)

    const result = await generateOrSkipNode(baseState as any)

    expect(runE2eLlmGenerator).toHaveBeenCalledOnce()
    expect(result.specs![0].generatedContent).toBeTruthy()
    expect(result.staticCheckAttempts).toBe(0)
  })

  it('generate=false → 跳过 spawnSync，直接调 LLM', async () => {
    vi.mocked(getE2eTargetProject).mockResolvedValue(makeProject(false) as any)

    const result = await generateOrSkipNode(baseState as any)

    expect(spawnSync).not.toHaveBeenCalled()
    expect(runE2eLlmGenerator).toHaveBeenCalledOnce()
    expect(result.specs![0].generatedContent).toBeTruthy()
    expect(result.staticCheckAttempts).toBe(0)
  })

  it('outScriptPath 格式验证：login.md → feature-a/login.spec.ts', async () => {
    vi.mocked(getE2eTargetProject).mockResolvedValue(makeProject(false) as any)

    const result = await generateOrSkipNode(baseState as any)

    const scriptPath = result.specs![0].scriptPath!
    expect(scriptPath).toContain('feature-a/login.spec.ts')
    expect(scriptPath).toMatch(/^tests\/e2e\//)
  })

  it('currentSpecIndex 越界 → 返回 {}', async () => {
    const result = await generateOrSkipNode({ ...baseState, currentSpecIndex: 99 } as any)

    expect(result).toEqual({})
    expect(getE2eTargetProject).not.toHaveBeenCalled()
  })
})
