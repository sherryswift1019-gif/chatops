import { describe, it, expect, vi } from 'vitest'

vi.mock('child_process', () => ({ spawnSync: vi.fn() }))
vi.mock('fs', () => ({ mkdirSync: vi.fn() }))
vi.mock('../../db/repositories/e2e-target-projects.js', () => ({
  getE2eTargetProject: vi.fn(),
}))

import { spawnSync } from 'child_process'
import { mkdirSync } from 'fs'
import { getE2eTargetProject } from '../../db/repositories/e2e-target-projects.js'
import { runBaselineCheckNode } from '../../e2e/pipeline-a/nodes/baseline-check.js'

const mockProject = {
  id: 'chatops',
  displayName: 'ChatOps',
  workingDir: '/app',
  scripts: { build: 'build.sh', deploy: 'deploy.sh', test: 'test.sh' },
  capabilities: {},
  gitlabRepo: '',
  defaultBranch: 'main',
  defaultSandboxKind: 'docker-compose-local',
  createdAt: new Date(),
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
  baselineAttempts: 0,
  lastBaselineResult: null,
  completedSpecs: [],
  maxBaselineAttempts: 3,
  lastError: null,
  staticCheckResult: null,
  diagnosisVerdict: null,
}

describe('runBaselineCheckNode', () => {
  it('测试脚本成功 (status=0) → lastBaselineResult.passed=true，baselineAttempts 递增', async () => {
    vi.mocked(getE2eTargetProject).mockResolvedValue(mockProject as any)
    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: '', stderr: '' } as any)

    const result = await runBaselineCheckNode(baseState as any)

    expect(result.lastBaselineResult?.passed).toBe(true)
    expect(result.baselineAttempts).toBe(1)
  })

  it('测试脚本失败 (status=1) → lastBaselineResult.passed=false，baselineAttempts 递增', async () => {
    vi.mocked(getE2eTargetProject).mockResolvedValue(mockProject as any)
    vi.mocked(spawnSync).mockReturnValue({ status: 1, stdout: '', stderr: '' } as any)

    const result = await runBaselineCheckNode(baseState as any)

    expect(result.lastBaselineResult?.passed).toBe(false)
    expect(result.baselineAttempts).toBe(1)
  })

  it('stdout 最后一行是有效 JSON with summary → evidenceSummary 使用 JSON 里的 summary', async () => {
    vi.mocked(getE2eTargetProject).mockResolvedValue(mockProject as any)
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: 'some output\n{"summary": "All 3 steps passed successfully"}',
      stderr: '',
    } as any)

    const result = await runBaselineCheckNode(baseState as any)

    expect(result.lastBaselineResult?.evidenceSummary).toBe('All 3 steps passed successfully')
  })

  it('stdout 最后一行非 JSON → evidenceSummary 使用默认格式', async () => {
    vi.mocked(getE2eTargetProject).mockResolvedValue(mockProject as any)
    vi.mocked(spawnSync).mockReturnValue({
      status: 1,
      stdout: 'some output\nnot json at all',
      stderr: '',
    } as any)

    const result = await runBaselineCheckNode(baseState as any)

    const scenarioId = 's'
    expect(result.lastBaselineResult?.evidenceSummary).toBe(`Baseline check FAILED for ${scenarioId}`)
  })
})
