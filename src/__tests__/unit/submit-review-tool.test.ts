import { describe, it, expect, beforeEach } from 'vitest'
import {
  submitReviewTool,
  validateSubmitReviewPayload,
  takeSubmittedReview,
  clearSubmittedReview,
  peekSubmittedReview,
} from '../../agent/tools/submit-review.js'
import type { TaskContext } from '../../agent/tools/types.js'
import { PRD_RULES } from '../../agent/prd/rules.js'

const ctx = (taskId = 'test-task-1'): TaskContext => ({
  taskId,
  groupId: 'g1',
  platform: 'dingtalk',
  initiatorId: 'u1',
  initiatorRole: 'developer',
  productLineId: 1,
})

// 拿任一合法 ruleId 便于构造合法 payload
const VALID_RULE_ID = PRD_RULES[0].id

describe('validateSubmitReviewPayload', () => {
  it('合法最小 payload 通过', () => {
    const result = validateSubmitReviewPayload({
      status: 'pass',
      findings: [],
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.status).toBe('pass')
      expect(result.value.findings).toEqual([])
    }
  })

  it('顶层非对象（null / array / 字符串）拒绝', () => {
    for (const raw of [null, [], 'foo', 123]) {
      const r = validateSubmitReviewPayload(raw as unknown)
      expect(r.ok).toBe(false)
    }
  })

  it('status 非法枚举拒绝并返回明确错误', () => {
    const r = validateSubmitReviewPayload({ status: 'unknown', findings: [] })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors.some((e) => e.includes('status'))).toBe(true)
    }
  })

  it('findings 缺失拒绝', () => {
    const r = validateSubmitReviewPayload({ status: 'pass' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors.some((e) => e.includes('findings'))).toBe(true)
    }
  })

  it('findings 元素非对象拒绝', () => {
    const r = validateSubmitReviewPayload({
      status: 'blocked',
      findings: ['bad', null],
    })
    expect(r.ok).toBe(false)
  })

  it('ruleId 不在 rules.ts 清单中拒绝', () => {
    const r = validateSubmitReviewPayload({
      status: 'blocked',
      findings: [
        {
          ruleId: 'definitely_not_a_rule',
          severity: 'blocker',
          location: '3.1',
          issue: 'x',
        },
      ],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors.some((e) => e.includes('不在 rules.ts 注册清单'))).toBe(
        true
      )
    }
  })

  it('severity 非法枚举拒绝', () => {
    const r = validateSubmitReviewPayload({
      status: 'blocked',
      findings: [
        {
          ruleId: VALID_RULE_ID,
          severity: 'critical', // 非法
          location: '3.1',
          issue: 'x',
        },
      ],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors.some((e) => e.includes('severity'))).toBe(true)
    }
  })

  it('location / issue 为空字符串拒绝', () => {
    const r = validateSubmitReviewPayload({
      status: 'blocked',
      findings: [
        {
          ruleId: VALID_RULE_ID,
          severity: 'blocker',
          location: '',
          issue: '',
        },
      ],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors.some((e) => e.includes('location'))).toBe(true)
      expect(r.errors.some((e) => e.includes('issue'))).toBe(true)
    }
  })

  it('可选字段 suggestion/canAutoFix/autoFixBlockedReason/ownership 类型错误拒绝', () => {
    const r = validateSubmitReviewPayload({
      status: 'blocked',
      findings: [
        {
          ruleId: VALID_RULE_ID,
          severity: 'blocker',
          location: '3.1',
          issue: 'x',
          suggestion: 123,
          canAutoFix: 'yes',
          autoFixBlockedReason: 456,
          ownership: 'dev', // 非法枚举
        },
      ],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors.some((e) => e.includes('suggestion'))).toBe(true)
      expect(r.errors.some((e) => e.includes('canAutoFix'))).toBe(true)
      expect(r.errors.some((e) => e.includes('autoFixBlockedReason'))).toBe(true)
      expect(r.errors.some((e) => e.includes('ownership'))).toBe(true)
    }
  })

  it('recommendation action 非法枚举 / reason 空拒绝', () => {
    const r = validateSubmitReviewPayload({
      status: 'pass',
      findings: [],
      recommendation: { action: 'ship_it', reason: '' },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors.some((e) => e.includes('recommendation.action'))).toBe(true)
      expect(r.errors.some((e) => e.includes('recommendation.reason'))).toBe(true)
    }
  })

  it('recommendation 完整合法通过', () => {
    const r = validateSubmitReviewPayload({
      status: 'warnings_only',
      findings: [],
      recommendation: {
        action: 'approve_with_edits',
        reason: '仅有 warning，建议作者补充后上线',
        confidence: 'high',
      },
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.recommendation?.action).toBe('approve_with_edits')
      expect(r.value.recommendation?.confidence).toBe('high')
    }
  })

  it('findings 完整字段合法通过并保留字段', () => {
    const r = validateSubmitReviewPayload({
      status: 'blocked',
      summary: '阻断',
      findings: [
        {
          ruleId: VALID_RULE_ID,
          severity: 'blocker',
          location: '3.2',
          issue: '缺少 CSV 模板字段',
          suggestion: '补齐字段列表',
          canAutoFix: true,
          autoFixBlockedReason: null,
          ownership: 'pm',
        },
      ],
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      const f = r.value.findings[0]
      expect(f.ruleId).toBe(VALID_RULE_ID)
      expect(f.canAutoFix).toBe(true)
      expect(f.autoFixBlockedReason).toBeUndefined() // null → undefined
      expect(f.ownership).toBe('pm')
    }
  })
})

describe('submittedBuffers 进程内缓冲', () => {
  beforeEach(() => {
    clearSubmittedReview('task-A')
    clearSubmittedReview('task-B')
  })

  it('take 未提交返回 null', () => {
    expect(takeSubmittedReview('task-A')).toBeNull()
  })

  it('execute 成功后 take 能拿到 payload，且拿一次就清空', async () => {
    const res = await submitReviewTool.execute(
      { status: 'pass', findings: [] },
      ctx('task-A')
    )
    expect(res.success).toBe(true)
    const taken = takeSubmittedReview('task-A')
    expect(taken).not.toBeNull()
    expect(taken?.status).toBe('pass')
    // 第二次 take 应为空
    expect(takeSubmittedReview('task-A')).toBeNull()
  })

  it('clear 显式清空', async () => {
    await submitReviewTool.execute(
      { status: 'pass', findings: [] },
      ctx('task-A')
    )
    clearSubmittedReview('task-A')
    expect(takeSubmittedReview('task-A')).toBeNull()
  })

  it('peek 不清空', async () => {
    await submitReviewTool.execute(
      { status: 'pass', findings: [] },
      ctx('task-A')
    )
    expect(peekSubmittedReview('task-A')?.status).toBe('pass')
    expect(peekSubmittedReview('task-A')?.status).toBe('pass') // 仍在
    takeSubmittedReview('task-A')
  })

  it('按 taskId 分桶，不会串', async () => {
    await submitReviewTool.execute(
      { status: 'pass', findings: [] },
      ctx('task-A')
    )
    await submitReviewTool.execute(
      { status: 'blocked', findings: [] },
      ctx('task-B')
    )
    expect(takeSubmittedReview('task-A')?.status).toBe('pass')
    expect(takeSubmittedReview('task-B')?.status).toBe('blocked')
  })
})

describe('submitReviewTool.execute', () => {
  beforeEach(() => {
    clearSubmittedReview('test-task-1')
  })

  it('schema 失败返回 success=false + 编号错误列表，不写 buffer', async () => {
    const res = await submitReviewTool.execute(
      {
        status: 'not_a_status',
        findings: [
          {
            ruleId: 'nope',
            severity: 'critical',
            location: '',
            issue: '',
          },
        ],
      },
      ctx()
    )
    expect(res.success).toBe(false)
    expect(res.output).toMatch(/schema 校验失败/)
    expect(res.output).toMatch(/^1\./m)
    expect(peekSubmittedReview('test-task-1')).toBeNull()
  })

  it('合法 payload 写 buffer，返回 data {status, findingCount}', async () => {
    const res = await submitReviewTool.execute(
      {
        status: 'blocked',
        findings: [
          {
            ruleId: VALID_RULE_ID,
            severity: 'blocker',
            location: '3.2',
            issue: '缺少 acceptance 公式',
          },
        ],
      },
      ctx()
    )
    expect(res.success).toBe(true)
    expect(res.data).toMatchObject({ status: 'blocked', findingCount: 1 })
    expect(res.output).toMatch(/已收到审查结果/)
    expect(res.output).toMatch(/不要输出额外文本/)
  })

  it('同 taskId 二次 submit 以最后一次为准并在 output 注明覆盖', async () => {
    const first = await submitReviewTool.execute(
      { status: 'pass', findings: [] },
      ctx()
    )
    expect(first.success).toBe(true)
    const second = await submitReviewTool.execute(
      { status: 'blocked', findings: [] },
      ctx()
    )
    expect(second.success).toBe(true)
    expect(second.output).toMatch(/覆盖了本轮之前的提交/)
    expect(takeSubmittedReview('test-task-1')?.status).toBe('blocked')
  })
})

describe('submitReviewTool 元信息', () => {
  it('riskLevel=low 且 name=submit_review', () => {
    expect(submitReviewTool.name).toBe('submit_review')
    expect(submitReviewTool.riskLevel).toBe('low')
  })

  it('inputSchema 声明 required=[status,findings] 且 findings.items.required 含 4 字段', () => {
    const schema = submitReviewTool.inputSchema as {
      required: string[]
      properties: {
        findings: { items: { required: string[] } }
      }
    }
    expect(schema.required).toEqual(expect.arrayContaining(['status', 'findings']))
    expect(schema.properties.findings.items.required).toEqual(
      expect.arrayContaining(['ruleId', 'severity', 'location', 'issue'])
    )
  })
})
