// src/__tests__/unit/e2e-fix-agent-node.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SandboxHandle } from '../../db/repositories/e2e-sandboxes.js'

vi.mock('../../agent/e2e-fix/runner.js', () => ({
  runE2eFix: vi.fn(),
}))

const _mockPool = { query: vi.fn().mockResolvedValue({ rows: [] }) }
vi.mock('../../db/client.js', () => ({
  getPool: vi.fn(() => _mockPool),
}))

const mockSandboxHandle: SandboxHandle & { containerId: string; workdir: string } = {
  envId: 'test-env-42',
  kind: 'docker-compose-local',
  endpoints: { web: 'http://localhost:13042' },
  containerId: 'sandbox-42-container',
  workdir: '/workspace/chatops',
}

describe('e2eFixAgentNode', () => {
  let runE2eFixMock: ReturnType<typeof vi.fn>
  let poolQueryMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.clearAllMocks()
    const runner = await import('../../agent/e2e-fix/runner.js')
    runE2eFixMock = runner.runE2eFix as ReturnType<typeof vi.fn>
    poolQueryMock = _mockPool.query
  })

  it('calls runE2eFix with correct params derived from state', async () => {
    runE2eFixMock.mockResolvedValue({
      success: true, fixCommitSha: 'def5678', verdict: 'product_bug',
      rootCauseSummary: 'missing null check', fixedFiles: ['src/pipeline/executor.ts'], failureReason: '',
    })

    const { e2eFixAgentNode } = await import('../../e2e/pipeline-b/nodes/e2e-fix-agent.js')
    await e2eFixAgentNode({
      sandboxHandle: mockSandboxHandle,
      iterationBranch: 'test-iter/42',
      evidenceDir: '/var/chatops/e2e-evidence/42/login-success/1',
      scenarioId: 'login-success',
      scenarioRunId: BigInt(99),
    })

    expect(runE2eFixMock).toHaveBeenCalledWith({
      scenarioId: 'login-success',
      evidenceDir: '/var/chatops/e2e-evidence/42/login-success/1',
      iterationBranch: 'test-iter/42',
      containerId: 'sandbox-42-container',
      workdir: '/workspace/chatops',
    })
  })

  it('writes aiDiagnosis into evidence_manifest via jsonb_set', async () => {
    runE2eFixMock.mockResolvedValue({
      success: true, fixCommitSha: 'def5678', verdict: 'product_bug',
      rootCauseSummary: 'missing null check', fixedFiles: ['src/pipeline/executor.ts'], failureReason: '',
    })

    const { e2eFixAgentNode } = await import('../../e2e/pipeline-b/nodes/e2e-fix-agent.js')
    await e2eFixAgentNode({
      sandboxHandle: mockSandboxHandle,
      iterationBranch: 'test-iter/42',
      evidenceDir: '/var/chatops/e2e-evidence/42/login-success/1',
      scenarioId: 'login-success',
      scenarioRunId: BigInt(99),
    })

    expect(poolQueryMock).toHaveBeenCalledWith(
      expect.stringContaining('jsonb_set'),
      expect.arrayContaining([BigInt(99)]),
    )
  })

  it('returns AiDiagnosis in lastFixResult on success', async () => {
    const diagnosis = {
      success: true, fixCommitSha: 'abc0001', verdict: 'product_bug' as const,
      rootCauseSummary: 'race condition in session manager',
      fixedFiles: ['src/agent/session-manager.ts'], failureReason: '',
    }
    runE2eFixMock.mockResolvedValue(diagnosis)

    const { e2eFixAgentNode } = await import('../../e2e/pipeline-b/nodes/e2e-fix-agent.js')
    const result = await e2eFixAgentNode({
      sandboxHandle: mockSandboxHandle,
      iterationBranch: 'test-iter/42',
      evidenceDir: '/var/chatops/e2e-evidence/42/create-prd/1',
      scenarioId: 'create-prd',
      scenarioRunId: BigInt(101),
    })

    expect(result.lastFixResult?.success).toBe(true)
    expect(result.lastFixResult?.fixCommitSha).toBe('abc0001')
    expect(result.lastFixResult?.verdict).toBe('product_bug')
  })

  it('returns lastFixResult with success=false when runE2eFix reports failure', async () => {
    runE2eFixMock.mockResolvedValue({
      success: false, fixCommitSha: null, verdict: 'uncertain',
      rootCauseSummary: 'could not reproduce', fixedFiles: [],
      failureReason: 'test passed during reproduce step — flaky',
    })

    const { e2eFixAgentNode } = await import('../../e2e/pipeline-b/nodes/e2e-fix-agent.js')
    const result = await e2eFixAgentNode({
      sandboxHandle: mockSandboxHandle,
      iterationBranch: 'test-iter/42',
      evidenceDir: '/var/chatops/e2e-evidence/42/approval-flow/2',
      scenarioId: 'approval-flow',
      scenarioRunId: BigInt(200),
    })

    expect(result.lastFixResult?.success).toBe(false)
    expect(result.lastFixResult?.failureReason).toMatch(/flaky/)
  })

  it('throws when sandboxHandle has no containerId', async () => {
    const { e2eFixAgentNode } = await import('../../e2e/pipeline-b/nodes/e2e-fix-agent.js')

    await expect(
      e2eFixAgentNode({
        sandboxHandle: { envId: 'x', kind: 'docker-compose-local', endpoints: {} } as SandboxHandle,
        iterationBranch: 'test-iter/42',
        evidenceDir: '/tmp/evidence',
        scenarioId: 'login-success',
        scenarioRunId: BigInt(1),
      }),
    ).rejects.toThrow(/containerId/)
  })
})
