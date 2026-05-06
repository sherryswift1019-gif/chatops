// src/__tests__/unit/scenario-runner-onmessage.test.ts
//
// 验 runE2eScenario 把 Porygon 流式消息（opts.onMessage）通过
// createOnMessageBridge 桥接到 scenario-event-bus：
//   - tool_use → bus.tool_use 事件，step 自增（1,2,...），phase='scenario'
//   - assistant(text) → assistant_text
//   - error(message) → agent_error
//   - 其它类型 ignore
//
// ClaudeRunner 用 __setRunnerForTesting 注入 fake；测试主轴是 bus 历史，
// manifest 解析仅作为附带（让 evidenceDir 有合法 manifest 让 runner 不拐去 errorMessage 分支）。

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  runE2eScenario,
  __setRunnerForTesting,
  __setSkillForTesting,
} from '../../agent/e2e-scenario/runner.js'
import {
  __resetForTesting,
  ensureRun,
  getHistory,
} from '../../e2e/pipeline-b/scenario-event-bus.js'
import type { Playbook } from '../../e2e/pipeline-b/playbook/types.js'
import type { SandboxHandle } from '../../e2e/pipeline-b/types.js'

// 让 ClaudeRunner 的 import 走通而不真连 DB —— 与 e2e-scenario-runner.test.ts 保持一致
import { vi } from 'vitest'
vi.mock('../../agent/claude-config.js', () => ({
  buildClaudeEnv: vi.fn().mockResolvedValue({}),
}))
vi.mock('../../agent/tools/index.js', () => ({
  getTool: vi.fn(),
  getAllTools: vi.fn(() => []),
  getPermittedTools: vi.fn(() => []),
}))

const NOW = '2026-05-06T08:00:00.000Z'

const fakePlaybook: Playbook = {
  specPath: 'docs/test-specs/login.md',
  specTitle: '登录测试',
  scenarios: [
    {
      id: 'sc-1',
      name: '登录成功',
      tags: [],
      steps: ['打开 /login'],
      acceptance: [{ kind: 'url_match', value: '/dashboard' }],
    },
  ],
}

const fakeSandbox: SandboxHandle = {
  envId: 'env-1',
  kind: 'docker-compose',
  endpoints: { web_base_url: 'http://localhost:32801' },
  internalRefs: {},
  containerId: 'fake-container',
  workdir: '/workspace',
}

function writeValidManifest(dir: string): void {
  const manifest = {
    scenarioId: 'sc-1',
    attemptNumber: 1,
    result: 'pass',
    startedAt: NOW,
    finishedAt: NOW,
    durationMs: 0,
    claudeTrace: [],
    acceptanceResults: [],
    artifacts: [],
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest))
}

describe('runE2eScenario onMessage 桥接', () => {
  let evidenceDir: string

  beforeEach(() => {
    __resetForTesting()
    __setSkillForTesting('FAKE SKILL')
    evidenceDir = mkdtempSync(join(tmpdir(), 'e2e-scenario-onmsg-test-'))
  })

  afterEach(() => {
    rmSync(evidenceDir, { recursive: true, force: true })
    __setRunnerForTesting(null)
    __setSkillForTesting(null)
  })

  it('Porygon tool_use 消息桥接成 bus tool_use 事件，step 自增、phase=scenario', async () => {
    const runId = 100n
    ensureRun(runId)

    __setRunnerForTesting({
      executeCapabilityDirect: async (opts: { onMessage?: (m: unknown) => void }) => {
        opts.onMessage?.({ type: 'tool_use', toolName: 'browser_click', input: { ref: 'btn' } })
        opts.onMessage?.({ type: 'tool_use', toolName: 'browser_navigate', input: { url: '/' } })
        opts.onMessage?.({ type: 'assistant', text: '我开始登录' })
        opts.onMessage?.({ type: 'error', message: 'API timeout' })
        writeValidManifest(evidenceDir)
        return ''
      },
    } as never)

    const r = await runE2eScenario({
      playbook: fakePlaybook,
      scenarioId: 'sc-1',
      evidenceDir,
      sandboxHandle: fakeSandbox,
      attemptNumber: 1,
      runId,
    })

    // 主轴：bus 历史
    const events = getHistory(runId)
    const toolUses = events.filter((e) => e.type === 'tool_use') as Array<
      Extract<ReturnType<typeof getHistory>[number], { type: 'tool_use' }>
    >
    expect(toolUses).toHaveLength(2)
    expect(toolUses[0].step).toBe(1)
    expect(toolUses[0].toolName).toBe('browser_click')
    expect(toolUses[0].phase).toBe('scenario')
    expect(toolUses[1].step).toBe(2)
    expect(toolUses[1].toolName).toBe('browser_navigate')
    expect(toolUses[1].phase).toBe('scenario')

    const assistantText = events.find((e) => e.type === 'assistant_text') as Extract<
      ReturnType<typeof getHistory>[number],
      { type: 'assistant_text' }
    > | undefined
    expect(assistantText).toBeDefined()
    expect(assistantText!.text).toBe('我开始登录')
    expect(assistantText!.phase).toBe('scenario')

    const agentErr = events.find((e) => e.type === 'agent_error') as Extract<
      ReturnType<typeof getHistory>[number],
      { type: 'agent_error' }
    > | undefined
    expect(agentErr).toBeDefined()
    expect(agentErr!.message).toBe('API timeout')
    expect(agentErr!.phase).toBe('scenario')

    // 附带：manifest 应当解析成功（合法 manifest 提前写入）
    expect(r.errorMessage).toBeNull()
    expect(r.manifest).not.toBeNull()
  })

  it('未知/无效消息类型不 emit 事件', async () => {
    const runId = 101n
    ensureRun(runId)

    __setRunnerForTesting({
      executeCapabilityDirect: async (opts: { onMessage?: (m: unknown) => void }) => {
        opts.onMessage?.({ type: 'system', text: 'irrelevant' })
        opts.onMessage?.({ type: 'progress' })
        opts.onMessage?.({ type: 'assistant' }) // 无 text 字段
        opts.onMessage?.({ type: 'error', message: '' }) // 空 message
        writeValidManifest(evidenceDir)
        return ''
      },
    } as never)

    await runE2eScenario({
      playbook: fakePlaybook,
      scenarioId: 'sc-1',
      evidenceDir,
      sandboxHandle: fakeSandbox,
      attemptNumber: 1,
      runId,
    })

    const events = getHistory(runId)
    expect(events.filter((e) => e.type === 'tool_use')).toHaveLength(0)
    expect(events.filter((e) => e.type === 'assistant_text')).toHaveLength(0)
    expect(events.filter((e) => e.type === 'agent_error')).toHaveLength(0)
  })

  it('scenarioId 不在 playbook → 早 return，不 emit 任何 bus 事件', async () => {
    const runId = 102n
    ensureRun(runId)

    let called = false
    __setRunnerForTesting({
      executeCapabilityDirect: async () => {
        called = true
        return ''
      },
    } as never)

    const r = await runE2eScenario({
      playbook: fakePlaybook,
      scenarioId: 'sc-not-exist',
      evidenceDir,
      sandboxHandle: fakeSandbox,
      attemptNumber: 1,
      runId,
    })

    expect(r.errorMessage).toMatch(/不在 playbook 中/)
    expect(called).toBe(false)
    expect(getHistory(runId)).toHaveLength(0)
  })

  it('多个 scenario 用同一 runId 时各 phase=scenario step 各自从 1 开始（每次调 runE2eScenario 是独立 bridge）', async () => {
    const runId = 103n
    ensureRun(runId)

    let attempt = 0
    __setRunnerForTesting({
      executeCapabilityDirect: async (opts: { onMessage?: (m: unknown) => void }) => {
        attempt += 1
        opts.onMessage?.({ type: 'tool_use', toolName: `tool-${attempt}-a`, input: {} })
        opts.onMessage?.({ type: 'tool_use', toolName: `tool-${attempt}-b`, input: {} })
        writeValidManifest(evidenceDir)
        return ''
      },
    } as never)

    await runE2eScenario({
      playbook: fakePlaybook,
      scenarioId: 'sc-1',
      evidenceDir,
      sandboxHandle: fakeSandbox,
      attemptNumber: 1,
      runId,
    })
    await runE2eScenario({
      playbook: fakePlaybook,
      scenarioId: 'sc-1',
      evidenceDir,
      sandboxHandle: fakeSandbox,
      attemptNumber: 2,
      runId,
    })

    const tools = getHistory(runId).filter((e) => e.type === 'tool_use') as Array<
      Extract<ReturnType<typeof getHistory>[number], { type: 'tool_use' }>
    >
    expect(tools.map((t) => ({ step: t.step, toolName: t.toolName }))).toEqual([
      { step: 1, toolName: 'tool-1-a' },
      { step: 2, toolName: 'tool-1-b' },
      { step: 1, toolName: 'tool-2-a' }, // 第二次 runE2eScenario 是新 bridge，step 重置
      { step: 2, toolName: 'tool-2-b' },
    ])
  })
})
