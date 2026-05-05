import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Manifest } from '../../e2e/pipeline-b/playbook/manifest.js'

vi.mock('../../agent/e2e-scenario/runner.js', () => ({
  runE2eScenario: vi.fn(),
}))

const { runE2eScenario } = await import('../../agent/e2e-scenario/runner.js')
const { runBaselineCheckNode } = await import('../../e2e/pipeline-a/nodes/baseline-check.js')

const VALID_PLAYBOOK_YAML = `
specPath: docs/test-specs/s.md
scenarios:
  - id: s.smoke
    name: Smoke
    tags: [smoke]
    acceptance:
      - kind: url_match
        value: /
  - id: s.full
    name: Full
    tags: []
    acceptance:
      - kind: api_response
        request: GET /healthz
        expect_status: 200
`

const PASS_MANIFEST: Manifest = {
  scenarioId: 's.smoke',
  attemptNumber: 1,
  result: 'pass',
  startedAt: '2026-05-05T10:00:00.000Z',
  finishedAt: '2026-05-05T10:00:30.000Z',
  durationMs: 30000,
  claudeTrace: [],
  acceptanceResults: [{ kind: 'url_match', index: 0, result: 'pass' }],
  artifacts: [],
}

const baseState = {
  specs: [
    {
      specId: 1n,
      specPath: 'docs/test-specs/s.md',
      title: 'S',
      contentHash: 'x',
      targetProjectId: 'chatops',
      scriptPath: 'docs/test-playbooks/s.playbook.yaml',
      generatedContent: VALID_PLAYBOOK_YAML,
    },
  ],
  currentSpecIndex: 0,
  staticCheckAttempts: 0,
  maxStaticCheckAttempts: 2,
  baseBranch: 'main',
  targetProjectId: 'chatops',
  specPaths: [],
  sandboxHandle: {
    envId: 'env-1',
    kind: 'docker-compose-local',
    endpoints: { web_base_url: 'http://localhost:3000' },
    internalRefs: {},
    sandboxId: 1n,
    containerId: 'sandbox-abc',
    workdir: '/app',
  },
  baselineAttempts: 0,
  lastBaselineResult: null,
  completedSpecs: [],
  maxBaselineAttempts: 3,
  lastError: null,
  staticCheckResult: null,
  diagnosisVerdict: null,
}

describe('runBaselineCheckNode (playbook-driven)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('所有 scenario 全 pass → lastBaselineResult.passed=true', async () => {
    vi.mocked(runE2eScenario).mockResolvedValue({
      manifest: PASS_MANIFEST,
      rawOutput: '',
      errorMessage: null,
    })
    const result = await runBaselineCheckNode(baseState as any)
    expect(result.lastBaselineResult?.passed).toBe(true)
    expect(result.baselineAttempts).toBe(1)
    // 2 个 scenario → runE2eScenario 调 2 次
    expect(vi.mocked(runE2eScenario)).toHaveBeenCalledTimes(2)
  })

  it('某个 scenario fail → lastBaselineResult.passed=false，summary 含失败 scenario id', async () => {
    const failManifest = { ...PASS_MANIFEST, result: 'fail' as const, acceptanceResults: [
      { kind: 'url_match', index: 0, result: 'fail' as const, reason: '页面没加载' },
    ]}
    vi.mocked(runE2eScenario)
      .mockResolvedValueOnce({ manifest: PASS_MANIFEST, rawOutput: '', errorMessage: null })
      .mockResolvedValueOnce({ manifest: failManifest, rawOutput: '', errorMessage: null })
    const result = await runBaselineCheckNode(baseState as any)
    expect(result.lastBaselineResult?.passed).toBe(false)
    expect(result.lastBaselineResult?.evidenceSummary).toContain('s.full')
  })

  it('runE2eScenario 抛错 → 视为 fail，summary 含错误信息', async () => {
    vi.mocked(runE2eScenario).mockResolvedValue({
      manifest: null,
      rawOutput: '',
      errorMessage: 'Claude timeout',
    })
    const result = await runBaselineCheckNode(baseState as any)
    expect(result.lastBaselineResult?.passed).toBe(false)
    expect(result.lastBaselineResult?.evidenceSummary).toContain('Claude timeout')
  })

  it('generatedContent 为空 → 直接 fail，不调 runE2eScenario', async () => {
    const state = { ...baseState, specs: [{ ...baseState.specs[0], generatedContent: undefined }] }
    const result = await runBaselineCheckNode(state as any)
    expect(result.lastBaselineResult?.passed).toBe(false)
    expect(result.lastBaselineResult?.evidenceSummary).toContain('generatedContent 为空')
    expect(vi.mocked(runE2eScenario)).not.toHaveBeenCalled()
  })

  it('playbook YAML 校验失败 → 直接 fail，不调 runE2eScenario', async () => {
    const state = {
      ...baseState,
      specs: [{ ...baseState.specs[0], generatedContent: 'specPath: x.md\nscenarios: []' }],
    }
    const result = await runBaselineCheckNode(state as any)
    expect(result.lastBaselineResult?.passed).toBe(false)
    expect(result.lastBaselineResult?.evidenceSummary).toContain('校验失败')
    expect(vi.mocked(runE2eScenario)).not.toHaveBeenCalled()
  })

  it('sandboxHandle 为 null → 抛错', async () => {
    const state = { ...baseState, sandboxHandle: null }
    await expect(runBaselineCheckNode(state as any)).rejects.toThrow(/sandboxHandle is null/)
  })
})
