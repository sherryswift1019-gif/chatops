// src/__tests__/unit/e2e-fix-runner-onmessage.test.ts
//
// 验证 runE2eFix 在调 ClaudeRunner.executeCapabilityDirect 时通过
// createOnMessageBridge 注入了一个 onMessage 回调，且 Porygon 流式消息
// 经桥接后正确写入 scenario-event-bus（phase=fix，step 自增）。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { runE2eFix, __setRunnerForTesting } from '../../agent/e2e-fix/runner.js'
import {
  __resetForTesting,
  ensureRun,
  getHistory,
  type ScenarioEvent,
} from '../../e2e/pipeline-b/scenario-event-bus.js'

// 让 fs.readFileSync('/.../SKILL.md') 不去真读盘
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    readFileSync: vi.fn((p: unknown, encoding?: unknown) => {
      const s = String(p)
      if (s.endsWith('/skill/SKILL.md') || s.endsWith('/e2e-fix/SKILL.md')) {
        return '# E2E Fix Skill\n(mock)'
      }
      return actual.readFileSync(p as string, encoding as BufferEncoding)
    }),
  }
})

describe('runE2eFix onMessage 桥接', () => {
  beforeEach(() => {
    __resetForTesting()
  })

  afterEach(() => {
    __setRunnerForTesting(null)
  })

  it('Porygon tool_use 桥接成 bus tool_use 事件，phase=fix，step 自增', async () => {
    const runId = 200n
    ensureRun(runId)

    const validDiagnosis = {
      verdict: 'product_bug',
      rootCauseSummary: 'X 模块空指针',
      commitSha: 'abc1234',
      fixedFiles: ['foo.ts'],
      success: true,
      failureReason: '',
    }

    __setRunnerForTesting({
      executeCapabilityDirect: async (opts: { onMessage?: (m: unknown) => void }) => {
        opts.onMessage?.({ type: 'tool_use', toolName: 'Bash', input: { command: 'git diff' } })
        opts.onMessage?.({ type: 'tool_use', toolName: 'Read', input: { path: '/workspace/foo.ts' } })
        opts.onMessage?.({ type: 'assistant', text: '我修复了 X 问题' })
        return JSON.stringify(validDiagnosis)
      },
    } as never)

    const result = await runE2eFix({
      scenarioId: 'sc-1',
      evidenceDir: '/tmp/evidence/sc-1',
      iterationBranch: 'test-iter/1',
      containerId: 'fake-container',
      workdir: '/workspace',
      runId,
    })

    expect(result.success).toBe(true)
    expect(result.verdict).toBe('product_bug')
    expect(result.fixCommitSha).toBe('abc1234')

    const events = getHistory(runId)
    const toolUses = events.filter((e) => e.type === 'tool_use') as Extract<
      ScenarioEvent,
      { type: 'tool_use' }
    >[]
    expect(toolUses).toHaveLength(2)
    expect(toolUses[0].phase).toBe('fix')
    expect(toolUses[0].step).toBe(1)
    expect(toolUses[0].toolName).toBe('Bash')
    expect(toolUses[1].phase).toBe('fix')
    expect(toolUses[1].step).toBe(2)
    expect(toolUses[1].toolName).toBe('Read')

    const assistantTexts = events.filter((e) => e.type === 'assistant_text') as Extract<
      ScenarioEvent,
      { type: 'assistant_text' }
    >[]
    expect(assistantTexts).toHaveLength(1)
    expect(assistantTexts[0].phase).toBe('fix')
    expect(assistantTexts[0].text).toContain('我修复了 X 问题')
  })

  it('error 类型 Porygon 消息桥接成 bus agent_error 事件', async () => {
    const runId = 201n
    ensureRun(runId)

    __setRunnerForTesting({
      executeCapabilityDirect: async (opts: { onMessage?: (m: unknown) => void }) => {
        opts.onMessage?.({ type: 'error', message: '工具调用失败：connection refused' })
        return JSON.stringify({
          verdict: 'uncertain',
          rootCauseSummary: '',
          commitSha: null,
          fixedFiles: [],
          success: false,
          failureReason: 'tool error',
        })
      },
    } as never)

    await runE2eFix({
      scenarioId: 'sc-2',
      evidenceDir: '/tmp/evidence/sc-2',
      iterationBranch: 'test-iter/2',
      containerId: 'fake-container',
      workdir: '/workspace',
      runId,
    })

    const events = getHistory(runId)
    const errors = events.filter((e) => e.type === 'agent_error') as Extract<
      ScenarioEvent,
      { type: 'agent_error' }
    >[]
    expect(errors).toHaveLength(1)
    expect(errors[0].phase).toBe('fix')
    expect(errors[0].message).toContain('connection refused')
  })

  it('未知 Porygon 消息类型被忽略（不写 bus）', async () => {
    const runId = 202n
    ensureRun(runId)

    __setRunnerForTesting({
      executeCapabilityDirect: async (opts: { onMessage?: (m: unknown) => void }) => {
        opts.onMessage?.({ type: 'system', text: 'noise' })
        opts.onMessage?.({ type: 'result', text: 'noise' })
        opts.onMessage?.({ type: 'progress' })
        return JSON.stringify({
          verdict: 'uncertain',
          rootCauseSummary: '',
          commitSha: null,
          fixedFiles: [],
          success: false,
          failureReason: '',
        })
      },
    } as never)

    await runE2eFix({
      scenarioId: 'sc-3',
      evidenceDir: '/tmp/evidence/sc-3',
      iterationBranch: 'test-iter/3',
      containerId: 'fake-container',
      workdir: '/workspace',
      runId,
    })

    const events = getHistory(runId)
    expect(events).toHaveLength(0)
  })
})
