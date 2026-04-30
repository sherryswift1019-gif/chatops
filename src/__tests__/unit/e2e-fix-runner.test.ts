// src/__tests__/unit/e2e-fix-runner.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { join } from 'path'
import { homedir } from 'os'

// mock claude-runner
vi.mock('../../agent/claude-runner.js', () => ({
  ClaudeRunner: vi.fn().mockImplementation(function () {
    return { executeCapabilityDirect: vi.fn() }
  }),
}))

// mock fs.readFileSync — 让 skill 路径返回假内容
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    readFileSync: vi.fn((p: unknown) => {
      const skillPath = join(homedir(), '.claude', 'skills', 'e2e-fix', 'SKILL.md')
      if (String(p) === skillPath) return '# E2E Fix Skill\n(mock skill content)'
      return actual.readFileSync(p as string, 'utf8')
    }),
  }
})

describe('runE2eFix', () => {
  let executeCapabilityDirectMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    executeCapabilityDirectMock = vi.fn()
    const { ClaudeRunner } = await import('../../agent/claude-runner.js')
    ;(ClaudeRunner as ReturnType<typeof vi.fn>).mockImplementation(function () {
      return { executeCapabilityDirect: executeCapabilityDirectMock }
    })
  })

  it('parses last JSON line from stdout on success', async () => {
    const payload = {
      success: true,
      commitSha: 'abc1234',
      verdict: 'product_bug',
      rootCauseSummary: 'null pointer in auth handler',
      fixedFiles: ['src/agent/auth.ts'],
      failureReason: '',
    }
    executeCapabilityDirectMock.mockResolvedValue(
      `Some Claude output\nthinking...\n${JSON.stringify(payload)}\n`,
    )

    const { runE2eFix } = await import('../../agent/e2e-fix/runner.js')
    const result = await runE2eFix({
      scenarioId: 'login-success',
      evidenceDir: '/tmp/evidence/login-success',
      iterationBranch: 'test-iter/42',
      containerId: 'sandbox-container-42',
      workdir: '/workspace/chatops',
    })

    expect(result.success).toBe(true)
    expect(result.fixCommitSha).toBe('abc1234')
    expect(result.verdict).toBe('product_bug')
    expect(result.fixedFiles).toEqual(['src/agent/auth.ts'])
  })

  it('returns success=false with failureReason when stdout has no valid JSON', async () => {
    executeCapabilityDirectMock.mockResolvedValue(
      'Claude said something but forgot to output the final JSON line',
    )

    const { runE2eFix } = await import('../../agent/e2e-fix/runner.js')
    const result = await runE2eFix({
      scenarioId: 'login-success',
      evidenceDir: '/tmp/evidence/login-success',
      iterationBranch: 'test-iter/42',
      containerId: 'sandbox-container-42',
      workdir: '/workspace/chatops',
    })

    expect(result.success).toBe(false)
    expect(result.fixCommitSha).toBeNull()
    expect(result.verdict).toBe('uncertain')
    expect(result.failureReason).toMatch(/no valid JSON/)
  })

  it('returns success=false when executeCapabilityDirect throws', async () => {
    executeCapabilityDirectMock.mockRejectedValue(new Error('timeout after 1800000ms'))

    const { runE2eFix } = await import('../../agent/e2e-fix/runner.js')
    const result = await runE2eFix({
      scenarioId: 'approval-flow',
      evidenceDir: '/tmp/evidence/approval-flow',
      iterationBranch: 'test-iter/42',
      containerId: 'sandbox-container-42',
      workdir: '/workspace/chatops',
    })

    expect(result.success).toBe(false)
    expect(result.failureReason).toMatch(/timeout/)
  })

  it('passes dockerExec containerId + timeoutMs to executeCapabilityDirect', async () => {
    executeCapabilityDirectMock.mockResolvedValue(
      JSON.stringify({
        success: false, commitSha: null, verdict: 'uncertain',
        rootCauseSummary: 'x', fixedFiles: [], failureReason: 'y',
      }),
    )

    const { runE2eFix } = await import('../../agent/e2e-fix/runner.js')
    await runE2eFix({
      scenarioId: 'create-prd',
      evidenceDir: '/tmp/evidence/create-prd',
      iterationBranch: 'test-iter/7',
      containerId: 'my-container-id',
      workdir: '/workspace/chatops',
    })

    expect(executeCapabilityDirectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dockerExec: expect.objectContaining({ containerId: 'my-container-id' }),
        timeoutMs: 30 * 60 * 1000,
        maxTurns: 40,
      }),
    )
  })

  it('reads skill from ~/.claude/skills/e2e-fix/SKILL.md as systemPrompt', async () => {
    executeCapabilityDirectMock.mockResolvedValue(
      JSON.stringify({
        success: false, commitSha: null, verdict: 'uncertain',
        rootCauseSummary: 'x', fixedFiles: [], failureReason: 'y',
      }),
    )

    const { runE2eFix } = await import('../../agent/e2e-fix/runner.js')
    await runE2eFix({
      scenarioId: 'create-prd',
      evidenceDir: '/tmp/evidence/create-prd',
      iterationBranch: 'test-iter/7',
      containerId: 'my-container-id',
      workdir: '/workspace/chatops',
    })

    expect(executeCapabilityDirectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: expect.stringContaining('E2E Fix Skill'),
      }),
    )
  })
})
