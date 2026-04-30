import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('fs', () => ({ readFileSync: vi.fn() }))
vi.mock('../../e2e/pipeline-a/llm-bridge.js', () => ({
  executeCapabilityDirectForE2e: vi.fn(),
}))

import { readFileSync } from 'fs'
import { executeCapabilityDirectForE2e } from '../../e2e/pipeline-a/llm-bridge.js'
import { diagnoseBaselineNode, fixScriptNode } from '../../e2e/pipeline-a/nodes/diagnose.js'

const baselineResult = {
  specId: 1n,
  passed: false,
  evidenceDir: '/tmp/evidence',
  evidenceSummary: 'Selector error on login button',
}

const baseState = {
  specs: [{ specId: 1n, specPath: 'docs/specs/feature-a/s.md', title: 'S', contentHash: 'x', targetProjectId: 'chatops', scriptPath: 'tests/e2e/feature-a/s.spec.ts' }],
  currentSpecIndex: 0,
  staticCheckAttempts: 0,
  maxStaticCheckAttempts: 2,
  baseBranch: 'main',
  targetProjectId: 'chatops',
  specPaths: [],
  sandboxHandle: null,
  baselineAttempts: 1,
  lastBaselineResult: baselineResult,
  completedSpecs: [],
  maxBaselineAttempts: 3,
  lastError: null,
  staticCheckResult: null,
  diagnosisVerdict: null,
}

describe('diagnoseBaselineNode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  it('LLM 返回 product_bug → diagnosisVerdict=product_bug', async () => {
    vi.mocked(readFileSync).mockImplementation(() => { throw new Error('not found') })
    vi.mocked(executeCapabilityDirectForE2e).mockResolvedValue('{"verdict": "product_bug"}')

    const result = await diagnoseBaselineNode(baseState as any)

    expect(result.diagnosisVerdict).toBe('product_bug')
  })

  it('LLM 返回 script_bug → diagnosisVerdict=script_bug', async () => {
    vi.mocked(readFileSync).mockImplementation(() => { throw new Error('not found') })
    vi.mocked(executeCapabilityDirectForE2e).mockResolvedValue('{"verdict": "script_bug"}')

    const result = await diagnoseBaselineNode(baseState as any)

    expect(result.diagnosisVerdict).toBe('script_bug')
  })

  it('LLM 返回垃圾字符串 → diagnosisVerdict 默认为 script_bug', async () => {
    vi.mocked(readFileSync).mockImplementation(() => { throw new Error('not found') })
    vi.mocked(executeCapabilityDirectForE2e).mockResolvedValue('sorry, I cannot determine the verdict')

    const result = await diagnoseBaselineNode(baseState as any)

    expect(result.diagnosisVerdict).toBe('script_bug')
  })

  it('lastBaselineResult 为 null → 返回 { diagnosisVerdict: script_bug }', async () => {
    const stateWithNullBaseline = { ...baseState, lastBaselineResult: null }

    const result = await diagnoseBaselineNode(stateWithNullBaseline as any)

    expect(result.diagnosisVerdict).toBe('script_bug')
    expect(vi.mocked(executeCapabilityDirectForE2e)).not.toHaveBeenCalled()
  })
})

describe('fixScriptNode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  it('spec.scriptPath 存在 → LLM 被调用，generatedContent 更新', async () => {
    vi.mocked(executeCapabilityDirectForE2e).mockResolvedValue('// fixed script content')

    const result = await fixScriptNode(baseState as any)

    expect(vi.mocked(executeCapabilityDirectForE2e)).toHaveBeenCalled()
    expect(result.specs?.[0]).toHaveProperty('generatedContent', '// fixed script content')
    expect(result.lastError).toBeNull()
  })

  it('spec.scriptPath 为 null → 返回 {}', async () => {
    const stateWithNoScript = {
      ...baseState,
      specs: [{ ...baseState.specs[0], scriptPath: null }],
    }

    const result = await fixScriptNode(stateWithNoScript as any)

    expect(result).toEqual({})
    expect(vi.mocked(executeCapabilityDirectForE2e)).not.toHaveBeenCalled()
  })
})
