import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runPrdReview, setPrdClaudeRunner } from '../../agent/prd/prd-agent.js'
import {
  submitReviewTool,
  clearSubmittedReview,
} from '../../agent/tools/submit-review.js'
import type { ReviewProgressEvent } from '../../agent/prd/prd-agent.js'
import type { ClaudeRunner } from '../../agent/claude-runner.js'
import type { AgentTool, TaskContext } from '../../agent/tools/types.js'

// =============================================================================
// 通过 vi.mock 控制 config.PRD_AGENT_V2_MODE
// =============================================================================

let currentMode: 'off' | 'shadow' | 'on' = 'on'

vi.mock('../../config.js', () => ({
  config: {
    get PRD_AGENT_V2_MODE() {
      return currentMode
    },
    DATABASE_URL: 'postgres://test',
    PORT: 3000,
    LANGCHAIN_TRACING_V2: false,
  },
}))

// =============================================================================
// DB repo mock
// =============================================================================

const mockGetPrd = vi.fn()
const mockUpdatePrdStatus = vi.fn()
const mockUpdatePrdReviewResult = vi.fn()
const mockAppendReviewHistory = vi.fn()
const mockUpdatePrdContent = vi.fn()
const mockMergePrdMetrics = vi.fn()

vi.mock('../../db/repositories/prd-documents.js', () => ({
  getPrdDocumentById: (...a: unknown[]) => mockGetPrd(...a),
  updatePrdStatus: (...a: unknown[]) => mockUpdatePrdStatus(...a),
  updatePrdReviewResult: (...a: unknown[]) => mockUpdatePrdReviewResult(...a),
  appendReviewHistory: (...a: unknown[]) => mockAppendReviewHistory(...a),
  updatePrdContent: (...a: unknown[]) => mockUpdatePrdContent(...a),
  mergePrdMetrics: (...a: unknown[]) => mockMergePrdMetrics(...a),
}))

vi.mock('../../db/client.js', () => ({
  getPool: () => ({
    query: vi.fn().mockResolvedValue({ rows: [] }),
  }),
}))

// =============================================================================
// Fake ClaudeRunner：选择性地触发 submit_review；用于控制 tool-call 是否发生
// =============================================================================

/** fresh PRD fixture；满足结构校验（≥9 章节 + ≥200 chars） */
function fakePrd(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  const body = Array.from({ length: 9 }, (_, i) => `## ${i + 1}. 章节${i + 1}\n\n这是章节正文，用来凑够结构校验的字数要求。`).join('\n\n')
  return {
    id: 42,
    productLineId: 1,
    title: '测试 PRD',
    version: 1,
    status: 'drafting',
    contentMarkdown: `# 测试 PRD\n\n${body}`,
    contentJson: {},
    reviewResult: null,
    reviewHistory: [],
    createdBy: 'u1',
    groupId: 'g1',
    platform: 'dingtalk',
    agentSessionId: 'sess-1',
    tags: [],
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

interface FakeRunnerOpts {
  /** 在 executeCapabilityDirect 调用时同步执行的回调，可以调 submitReviewTool 写 buffer */
  onExecute?: (opts: {
    context: TaskContext
    prompt: string
    tools: AgentTool[]
    sessionKey?: string
  }) => Promise<void> | void
}

function buildFakeRunner(opts: FakeRunnerOpts = {}): {
  runner: ClaudeRunner
  calls: Array<{ context: TaskContext; prompt: string; sessionKey?: string; tools: AgentTool[] }>
} {
  const calls: Array<{ context: TaskContext; prompt: string; sessionKey?: string; tools: AgentTool[] }> = []
  const runner = {
    async executeCapabilityDirect(o: {
      prompt: string
      systemPrompt: string
      context: TaskContext
      tools: AgentTool[]
      sessionKey?: string
      freshSession?: boolean
      maxTurns?: number
      timeoutMs?: number
    }): Promise<string> {
      calls.push({
        context: o.context,
        prompt: o.prompt,
        sessionKey: o.sessionKey,
        tools: o.tools,
      })
      await opts.onExecute?.(o)
      return '' // 本 slice 的自审路径只看 submit_review buffer，忽略文本
    },
  } as unknown as ClaudeRunner
  return { runner, calls }
}

// =============================================================================
// Tests
// =============================================================================

describe('runPrdReview flag routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetPrd.mockResolvedValue(fakePrd())
    mockMergePrdMetrics.mockResolvedValue(undefined)
    clearSubmittedReview('any') // 防万一
    currentMode = 'on'
  })

  // ===========================================================================
  // off: 完全跳过，runner 不应被调用
  // ===========================================================================

  describe('PRD_AGENT_V2_MODE=off', () => {
    beforeEach(() => {
      currentMode = 'off'
    })

    it('runner 不被调用', async () => {
      const { runner, calls } = buildFakeRunner()
      setPrdClaudeRunner(runner)
      await runPrdReview(42)
      expect(calls.length).toBe(0)
    })

    it('PRD 直接标为 draft + 空 findings', async () => {
      const { runner } = buildFakeRunner()
      setPrdClaudeRunner(runner)
      await runPrdReview(42)
      expect(mockUpdatePrdReviewResult).toHaveBeenCalledTimes(1)
      const [, result, status] = mockUpdatePrdReviewResult.mock.calls[0]
      expect(status).toBe('draft')
      expect(result.findings).toEqual([])
      expect(result.status).toBe('passed')
      expect(result.round).toBe(0)
    })

    it('不写 reviewing 中间态（updatePrdStatus 不被调用）', async () => {
      const { runner } = buildFakeRunner()
      setPrdClaudeRunner(runner)
      await runPrdReview(42)
      expect(mockUpdatePrdStatus).not.toHaveBeenCalled()
    })

    it('结构校验也被跳过（即便 PRD 内容过短）', async () => {
      mockGetPrd.mockResolvedValueOnce(
        fakePrd({ contentMarkdown: '# 只有一行' })
      )
      const { runner, calls } = buildFakeRunner()
      setPrdClaudeRunner(runner)
      await runPrdReview(42)
      // off 短路早于结构校验 → runner 不调用，不进入 structure_failed 分支
      expect(calls.length).toBe(0)
      const [, , status] = mockUpdatePrdReviewResult.mock.calls[0]
      expect(status).toBe('draft')
    })

    it('emit review_started + review_finalized(finalStatus=draft)', async () => {
      const { runner } = buildFakeRunner()
      setPrdClaudeRunner(runner)
      const events: ReviewProgressEvent[] = []
      await runPrdReview(42, { onProgress: (ev) => events.push(ev) })
      const stages = events.map((e) => e.stage)
      expect(stages).toContain('review_started')
      const finalized = events.find((e) => e.stage === 'review_finalized')
      expect(finalized).toBeDefined()
      if (finalized && finalized.stage === 'review_finalized') {
        expect(finalized.finalStatus).toBe('draft')
      }
    })
  })

  // ===========================================================================
  // shadow: 跑一轮，有 blocker 也强制 draft，不走自修复
  // ===========================================================================

  describe('PRD_AGENT_V2_MODE=shadow', () => {
    beforeEach(() => {
      currentMode = 'shadow'
    })

    it('runner 只被调用 1 次（不进入自修复循环）', async () => {
      const { runner, calls } = buildFakeRunner({
        onExecute: async ({ context }) => {
          await submitReviewTool.execute(
            {
              status: 'blocked',
              findings: [
                {
                  ruleId: 'source_traceable',
                  severity: 'blocker',
                  location: '3.1',
                  issue: '缺来源',
                  canAutoFix: true,
                  ownership: 'pm',
                },
              ],
              recommendation: { action: 'reject', reason: 'shadow 下无关紧要' },
            },
            context
          )
        },
      })
      setPrdClaudeRunner(runner)
      await runPrdReview(42)
      expect(calls.length).toBe(1)
    })

    it('blocker 存在时仍强制 draft（不升级人工）', async () => {
      const { runner } = buildFakeRunner({
        onExecute: async ({ context }) => {
          await submitReviewTool.execute(
            {
              status: 'blocked',
              findings: [
                {
                  ruleId: 'source_traceable',
                  severity: 'blocker',
                  location: '3.1',
                  issue: '缺来源',
                  ownership: 'pm',
                },
              ],
            },
            context
          )
        },
      })
      setPrdClaudeRunner(runner)
      await runPrdReview(42)
      const [, , status] = mockUpdatePrdReviewResult.mock.calls[0]
      expect(status).toBe('draft')
    })

    it('findings 仍被持久化到 reviewHistory（观测用）', async () => {
      const { runner } = buildFakeRunner({
        onExecute: async ({ context }) => {
          await submitReviewTool.execute(
            {
              status: 'warnings_only',
              findings: [
                {
                  ruleId: 'no_soft_language',
                  severity: 'warning',
                  location: '1.1',
                  issue: '软化用语',
                },
              ],
            },
            context
          )
        },
      })
      setPrdClaudeRunner(runner)
      await runPrdReview(42)
      expect(mockAppendReviewHistory).toHaveBeenCalled()
      const [, entry] = mockAppendReviewHistory.mock.calls[0]
      expect(entry.result.findings).toHaveLength(1)
      expect(entry.result.findings[0].dimension).toBe('no_soft_language')
    })

    it('finalStatus=draft 事件被 emit', async () => {
      const { runner } = buildFakeRunner({
        onExecute: async ({ context }) => {
          await submitReviewTool.execute(
            {
              status: 'blocked',
              findings: [
                {
                  ruleId: 'closed_loop',
                  severity: 'blocker',
                  location: '3.2',
                  issue: '5W 不全',
                  ownership: 'pm',
                },
              ],
            },
            context
          )
        },
      })
      setPrdClaudeRunner(runner)
      const events: ReviewProgressEvent[] = []
      await runPrdReview(42, { onProgress: (ev) => events.push(ev) })
      const finalized = events.find((e) => e.stage === 'review_finalized')
      expect(finalized).toBeDefined()
      if (finalized && finalized.stage === 'review_finalized') {
        expect(finalized.finalStatus).toBe('draft')
      }
      // shadow 下不应有 repair_started 事件
      expect(events.some((e) => e.stage === 'repair_started')).toBe(false)
    })
  })

  // ===========================================================================
  // on: 完整 V2 行为，无 blocker → draft；submit_review 未调用 → 2 次尝试后 blocked
  // ===========================================================================

  describe('PRD_AGENT_V2_MODE=on', () => {
    beforeEach(() => {
      currentMode = 'on'
    })

    it('无 blocker → draft', async () => {
      const { runner } = buildFakeRunner({
        onExecute: async ({ context }) => {
          await submitReviewTool.execute(
            {
              status: 'pass',
              findings: [],
            },
            context
          )
        },
      })
      setPrdClaudeRunner(runner)
      await runPrdReview(42)
      const [, , status] = mockUpdatePrdReviewResult.mock.calls[0]
      expect(status).toBe('draft')
    })

    it('submit_review 从未被调用 → 2 次尝试后 review_blocked（契约失败）', async () => {
      // runner 不触发 submitReviewTool → buffer 始终为空
      const { runner, calls } = buildFakeRunner()
      setPrdClaudeRunner(runner)
      await runPrdReview(42)
      // 首轮 attempt1 + attempt2 = 2 次 runner 调用
      expect(calls.length).toBe(2)
      const [, result, status] = mockUpdatePrdReviewResult.mock.calls[0]
      expect(status).toBe('review_blocked')
      expect(result.findings[0].dimension).toBe('submit_review_missing')
    })

    it('第 1 次 submit_review 失败、第 2 次成功 → 单轮正常完成', async () => {
      let callIdx = 0
      const { runner, calls } = buildFakeRunner({
        onExecute: async ({ context }) => {
          callIdx++
          if (callIdx === 2) {
            await submitReviewTool.execute(
              { status: 'pass', findings: [] },
              context
            )
          }
          // 第 1 次不调用 submit_review
        },
      })
      setPrdClaudeRunner(runner)
      await runPrdReview(42)
      expect(calls.length).toBe(2)
      const [, , status] = mockUpdatePrdReviewResult.mock.calls[0]
      expect(status).toBe('draft')
    })
  })

  // ===========================================================================
  // V2.0 baseline 埋点写回：review/repair 计数 + duration + rulesVersion
  // ===========================================================================
  describe('metrics 埋点写回', () => {
    beforeEach(() => {
      currentMode = 'on'
    })

    it('happy path（1 次 review 通过，无 repair）→ mergePrdMetrics 被调 1 次且 delta 正确', async () => {
      const { runner } = buildFakeRunner({
        onExecute: async ({ context }) => {
          await submitReviewTool.execute(
            { status: 'pass', findings: [] },
            context
          )
        },
      })
      setPrdClaudeRunner(runner)
      await runPrdReview(42)

      expect(mockMergePrdMetrics).toHaveBeenCalledTimes(1)
      const [prdId, patch] = mockMergePrdMetrics.mock.calls[0]
      expect(prdId).toBe(42)
      expect(patch.llmCallsDelta).toEqual({ review: 1, repair: 0 })
      expect(typeof patch.reviewDurationMs).toBe('number')
      expect(patch.reviewDurationMs).toBeGreaterThanOrEqual(0)
      expect(patch.rulesVersion).toMatch(/^rules-/)
    })

    it('契约失败（2 次 review attempt 都没 submit）→ review=2、repair=0', async () => {
      const { runner } = buildFakeRunner({ onExecute: async () => {} })
      setPrdClaudeRunner(runner)
      await runPrdReview(42)

      expect(mockMergePrdMetrics).toHaveBeenCalledTimes(1)
      const [, patch] = mockMergePrdMetrics.mock.calls[0]
      expect(patch.llmCallsDelta).toEqual({ review: 2, repair: 0 })
    })

    it('off 分支 kill-switch：不写埋点（跳过整个 review 链路）', async () => {
      currentMode = 'off'
      const { runner } = buildFakeRunner()
      setPrdClaudeRunner(runner)
      await runPrdReview(42)

      expect(mockMergePrdMetrics).not.toHaveBeenCalled()
    })

    it('结构校验失败分支：不写埋点（未进入 AI 自审 try 块）', async () => {
      mockGetPrd.mockResolvedValueOnce(
        fakePrd({ contentMarkdown: '# 只有一行不够 200 字' })
      )
      const { runner } = buildFakeRunner()
      setPrdClaudeRunner(runner)
      await runPrdReview(42)

      expect(mockMergePrdMetrics).not.toHaveBeenCalled()
    })
  })
})
