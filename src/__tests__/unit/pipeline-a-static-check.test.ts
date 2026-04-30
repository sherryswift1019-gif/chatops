import { describe, it, expect, vi } from 'vitest'

vi.mock('child_process', () => ({ spawnSync: vi.fn() }))

import { spawnSync } from 'child_process'
import { staticCheckNode } from '../../e2e/pipeline-a/nodes/static-check.js'

const baseState = {
  specs: [{ specId: 1n, specPath: 'docs/s.md', title: 'S', contentHash: 'x', targetProjectId: 'chatops', scriptPath: 'tests/e2e/s.spec.ts' }],
  currentSpecIndex: 0,
  staticCheckAttempts: 0,
  maxStaticCheckAttempts: 2,
  baseBranch: 'main',
  targetProjectId: 'chatops',
  specPaths: [],
  sandboxHandle: null,
  baselineAttempts: 0,
  lastBaselineResult: null,
  completedSpecs: [],
  maxBaselineAttempts: 3,
  lastError: null,
  staticCheckResult: null,
  diagnosisVerdict: null,
}

describe('staticCheckNode', () => {
  it('tsc 通过 → staticCheckResult=pass', async () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: '', stderr: '' } as any)
    const result = await staticCheckNode(baseState as any)
    expect(result.staticCheckResult).toBe('pass')
  })

  it('tsc 失败 → staticCheckResult=fail + stderr 存入 lastError', async () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 1, stdout: '', stderr: "error TS2345: ..." } as any)
    const result = await staticCheckNode(baseState as any)
    expect(result.staticCheckResult).toBe('fail')
    expect(result.lastError).toContain('TS2345')
  })
})
