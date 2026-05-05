// src/__tests__/unit/e2e-scenario-runner.test.ts
//
// 验 host scenario runner 的 IO 契约：
//   - 输入校验（scenarioId 是否在 playbook、SKILL 缺失）
//   - 调 ClaudeRunner.executeCapabilityDirect 时传的 disallowedTools / extraMcpServers / tools
//   - prompt 包含必要上下文（scenarioId / evidenceDir / containerId / scenario YAML）
//   - 跑完读 evidenceDir/manifest.json 并 schema 校验
//   - 各种失败分支返回 errorMessage
//
// ClaudeRunner 是注入桩 (__setRunnerForTesting)，不真起子进程。
// SKILL.md 也是注入桩 (__setSkillForTesting)，不依赖 ~/.claude。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  runE2eScenario,
  __setRunnerForTesting,
  __setSkillForTesting,
} from '../../agent/e2e-scenario/runner.js'
import type { Playbook } from '../../e2e/pipeline-b/playbook/types.js'
import type { SandboxHandle } from '../../e2e/pipeline-b/types.js'

// 让 buildClaudeEnv 不连 DB（runner 真起 ClaudeRunner 时会被 import）
vi.mock('../../agent/claude-config.js', () => ({
  buildClaudeEnv: vi.fn().mockResolvedValue({}),
}))

vi.mock('../../agent/tools/index.js', () => ({
  getTool: vi.fn(),
  getAllTools: vi.fn(() => []),
  getPermittedTools: vi.fn(() => []),
}))

interface CapturedCall {
  prompt: string
  systemPrompt: string
  tools: unknown[]
  disallowedTools?: string[]
  extraMcpServers?: Record<string, unknown>
  sessionKey?: string
  freshSession?: boolean
}

function makeFakeRunner(opts: {
  output?: string
  throwError?: Error
  onCall?: (call: CapturedCall) => void
}): { calls: CapturedCall[]; runner: { executeCapabilityDirect: (o: Record<string, unknown>) => Promise<string> } } {
  const calls: CapturedCall[] = []
  return {
    calls,
    runner: {
      executeCapabilityDirect: vi.fn(async (o: Record<string, unknown>) => {
        const captured: CapturedCall = {
          prompt: String(o.prompt),
          systemPrompt: String(o.systemPrompt),
          tools: o.tools as unknown[],
          disallowedTools: o.disallowedTools as string[] | undefined,
          extraMcpServers: o.extraMcpServers as Record<string, unknown> | undefined,
          sessionKey: o.sessionKey as string | undefined,
          freshSession: o.freshSession as boolean | undefined,
        }
        calls.push(captured)
        opts.onCall?.(captured)
        if (opts.throwError) throw opts.throwError
        return opts.output ?? ''
      }),
    },
  }
}

const samplePlaybook: Playbook = {
  specPath: 'docs/test-specs/login.md',
  specTitle: '用户登录',
  scenarios: [
    {
      id: 'login.success',
      name: '正确账号密码登录成功',
      tags: ['smoke'],
      steps: ['打开 /login', '提交登录'],
      acceptance: [{ kind: 'url_match', value: '/dashboard' }],
    },
  ],
}

const sampleSandbox: SandboxHandle = {
  envId: 'env-1',
  kind: 'docker-compose',
  endpoints: { web_base_url: 'http://localhost:32801', app_db_dsn: 'postgres://x' },
  internalRefs: {},
  containerId: 'sandbox-abc123',
  workdir: '/workspace',
}

const SKILL_STUB = '# E2E Scenario Runner\n(stub for tests)'
const NOW = '2026-05-02T10:00:00.000Z'

const validManifest = {
  scenarioId: 'login.success',
  attemptNumber: 1,
  result: 'pass',
  startedAt: NOW,
  finishedAt: NOW,
  durationMs: 1234,
  claudeTrace: [],
  acceptanceResults: [
    { kind: 'url_match', index: 0, result: 'pass', expected: '/dashboard', actual: '/dashboard' },
  ],
  artifacts: [],
}

describe('runE2eScenario', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'e2e-scenario-test-'))
    __setSkillForTesting(SKILL_STUB)
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    __setRunnerForTesting(null)
    __setSkillForTesting(null)
  })

  it('scenarioId 不在 playbook → errorMessage', async () => {
    const r = await runE2eScenario({
      playbook: samplePlaybook,
      scenarioId: 'login.unknown',
      evidenceDir: tempDir,
      sandboxHandle: sampleSandbox,
      attemptNumber: 1,
    })
    expect(r.manifest).toBeNull()
    expect(r.errorMessage).toMatch(/不在 playbook 中/)
  })

  it('SKILL.md 读取失败 → errorMessage', async () => {
    __setSkillForTesting(new Error('ENOENT'))
    const fakeRunner = makeFakeRunner({ output: '' })
    __setRunnerForTesting(fakeRunner.runner as never)

    const r = await runE2eScenario({
      playbook: samplePlaybook,
      scenarioId: 'login.success',
      evidenceDir: tempDir,
      sandboxHandle: sampleSandbox,
      attemptNumber: 1,
    })
    expect(r.manifest).toBeNull()
    expect(r.errorMessage).toMatch(/SKILL\.md 未找到/)
    // 确认未走到 ClaudeRunner（短路返回）
    expect(fakeRunner.calls).toHaveLength(0)
  })

  it('happy path：Claude 写出合法 manifest.json → 返回 parsed manifest', async () => {
    const fakeRunner = makeFakeRunner({
      output: 'done',
      onCall: () => {
        writeFileSync(
          join(tempDir, 'manifest.json'),
          JSON.stringify(validManifest),
        )
      },
    })
    __setRunnerForTesting(fakeRunner.runner as never)

    const r = await runE2eScenario({
      playbook: samplePlaybook,
      scenarioId: 'login.success',
      evidenceDir: tempDir,
      sandboxHandle: sampleSandbox,
      attemptNumber: 2,
    })
    expect(r.errorMessage).toBeNull()
    expect(r.manifest).not.toBeNull()
    expect(r.manifest!.scenarioId).toBe('login.success')
    expect(r.manifest!.result).toBe('pass')
    expect(r.rawOutput).toBe('done')
  })

  it('Claude 完成但没写 manifest.json → errorMessage', async () => {
    const fakeRunner = makeFakeRunner({ output: 'all done' })
    __setRunnerForTesting(fakeRunner.runner as never)

    const r = await runE2eScenario({
      playbook: samplePlaybook,
      scenarioId: 'login.success',
      evidenceDir: tempDir,
      sandboxHandle: sampleSandbox,
      attemptNumber: 1,
    })
    expect(r.manifest).toBeNull()
    expect(r.errorMessage).toMatch(/未写出.*manifest\.json/)
    expect(r.rawOutput).toBe('all done')
  })

  it('manifest.json 不合法 → schema 错误信息', async () => {
    const fakeRunner = makeFakeRunner({
      output: '',
      onCall: () => {
        writeFileSync(
          join(tempDir, 'manifest.json'),
          JSON.stringify({ scenarioId: 'login.success', result: 'flaky' }), // result 非法
        )
      },
    })
    __setRunnerForTesting(fakeRunner.runner as never)

    const r = await runE2eScenario({
      playbook: samplePlaybook,
      scenarioId: 'login.success',
      evidenceDir: tempDir,
      sandboxHandle: sampleSandbox,
      attemptNumber: 1,
    })
    expect(r.manifest).toBeNull()
    expect(r.errorMessage).toMatch(/schema 校验失败/)
  })

  it('Claude 抛错 → errorMessage，rawOutput 空', async () => {
    const fakeRunner = makeFakeRunner({ throwError: new Error('Claude timeout') })
    __setRunnerForTesting(fakeRunner.runner as never)

    const r = await runE2eScenario({
      playbook: samplePlaybook,
      scenarioId: 'login.success',
      evidenceDir: tempDir,
      sandboxHandle: sampleSandbox,
      attemptNumber: 1,
    })
    expect(r.manifest).toBeNull()
    expect(r.errorMessage).toBe('Claude timeout')
    expect(r.rawOutput).toBe('')
  })

  it('调 executeCapabilityDirect 时透传正确的工具配置', async () => {
    const fakeRunner = makeFakeRunner({
      output: '',
      onCall: () => {
        writeFileSync(join(tempDir, 'manifest.json'), JSON.stringify(validManifest))
      },
    })
    __setRunnerForTesting(fakeRunner.runner as never)

    await runE2eScenario({
      playbook: samplePlaybook,
      scenarioId: 'login.success',
      evidenceDir: tempDir,
      sandboxHandle: sampleSandbox,
      attemptNumber: 3,
    })

    expect(fakeRunner.calls).toHaveLength(1)
    const call = fakeRunner.calls[0]
    expect(call.tools).toEqual([])
    expect(call.disallowedTools).toEqual(['WebSearch', 'WebFetch', 'Agent'])
    expect(call.extraMcpServers).toBeDefined()
    expect(Object.keys(call.extraMcpServers!)).toEqual(['playwright'])
    expect(call.freshSession).toBe(true)
    expect(call.sessionKey).toBe('e2e-scenario-login.success-3')
  })

  it('prompt 含关键上下文（scenarioId / evidenceDir / containerId / scenario YAML）', async () => {
    const fakeRunner = makeFakeRunner({
      output: '',
      onCall: () => {
        writeFileSync(join(tempDir, 'manifest.json'), JSON.stringify(validManifest))
      },
    })
    __setRunnerForTesting(fakeRunner.runner as never)

    await runE2eScenario({
      playbook: samplePlaybook,
      scenarioId: 'login.success',
      evidenceDir: tempDir,
      sandboxHandle: sampleSandbox,
      attemptNumber: 1,
    })

    const prompt = fakeRunner.calls[0].prompt
    expect(prompt).toContain('login.success')
    expect(prompt).toContain(tempDir)
    expect(prompt).toContain('sandbox-abc123')
    expect(prompt).toContain('/workspace')
    expect(prompt).toContain('web_base_url')
    expect(prompt).toContain('docs/test-specs/login.md')
    // YAML 部分
    expect(prompt).toMatch(/scenarios:\s*\n\s*- id: login\.success/)
  })

  it('systemPrompt 是注入的 SKILL stub', async () => {
    const fakeRunner = makeFakeRunner({
      output: '',
      onCall: () => {
        writeFileSync(join(tempDir, 'manifest.json'), JSON.stringify(validManifest))
      },
    })
    __setRunnerForTesting(fakeRunner.runner as never)

    await runE2eScenario({
      playbook: samplePlaybook,
      scenarioId: 'login.success',
      evidenceDir: tempDir,
      sandboxHandle: sampleSandbox,
      attemptNumber: 1,
    })

    expect(fakeRunner.calls[0].systemPrompt).toBe(SKILL_STUB)
  })

  it('evidenceDir 不存在 → 把 manifest 缺失视为 errorMessage', async () => {
    const missingDir = join(tempDir, 'does-not-exist')
    mkdirSync(missingDir, { recursive: false }) // 目录在但里面没文件
    const fakeRunner = makeFakeRunner({ output: '' }) // 不写 manifest
    __setRunnerForTesting(fakeRunner.runner as never)

    const r = await runE2eScenario({
      playbook: samplePlaybook,
      scenarioId: 'login.success',
      evidenceDir: missingDir,
      sandboxHandle: sampleSandbox,
      attemptNumber: 1,
    })
    expect(r.manifest).toBeNull()
    expect(r.errorMessage).toMatch(/未写出/)
  })
})
