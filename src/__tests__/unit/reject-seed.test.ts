import { describe, it, expect } from 'vitest'
import {
  buildRejectSeedText,
  buildRejectSystemPromptAppendix,
  extractRejectContext,
} from '../../agent/prd/reject-seed.js'
import type {
  PrdDocument,
  PrdReviewFinding,
  PrdReviewHistoryEntry,
} from '../../db/repositories/prd-documents.js'

function makePrd(
  overrides: Partial<PrdDocument> = {}
): PrdDocument {
  return {
    id: 42,
    productLineId: 1,
    title: '订单导出',
    version: 3,
    status: 'drafting',
    contentMarkdown: '',
    contentJson: {},
    reviewResult: null,
    reviewHistory: [],
    createdBy: 'alice',
    groupId: null,
    platform: null,
    agentSessionId: null,
    tags: [],
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function rejectEntry(reason: string, round = 2): PrdReviewHistoryEntry {
  return {
    round,
    result: {
      status: 'blocked',
      round,
      findings: [],
      recommendation: { action: 'reject', reason },
      reviewedAt: new Date().toISOString(),
    },
  }
}

function blockerEntry(
  findings: PrdReviewFinding[],
  round = 1
): PrdReviewHistoryEntry {
  return {
    round,
    result: {
      status: 'blocked',
      round,
      findings,
      reviewedAt: new Date().toISOString(),
    },
  }
}

const finding = (desc: string, severity: PrdReviewFinding['severity'] = 'blocker'): PrdReviewFinding => ({
  id: `f-${desc.slice(0, 4)}`,
  dimension: 'structure',
  severity,
  location: '§2',
  description: desc,
  canAutoFix: false,
})

describe('extractRejectContext', () => {
  it('无 history 返回 null', () => {
    expect(extractRejectContext(makePrd({ reviewHistory: [] }))).toBeNull()
  })

  it('末条不是 reject 返回 null', () => {
    const prd = makePrd({
      reviewHistory: [
        {
          round: 1,
          result: {
            status: 'passed',
            round: 1,
            findings: [],
            recommendation: { action: 'approve', reason: 'ok' },
            reviewedAt: new Date().toISOString(),
          },
        },
      ],
    })
    expect(extractRejectContext(prd)).toBeNull()
  })

  it('只有 reject entry、无历史 blockers → blockers 空但 reason 有', () => {
    const prd = makePrd({ reviewHistory: [rejectEntry('人工驳回: 不清楚')] })
    const ctx = extractRejectContext(prd)
    expect(ctx?.reason).toBe('人工驳回: 不清楚')
    expect(ctx?.blockers).toEqual([])
  })

  it('reject + 上一轮有 blockers → 回溯拿到 blockers', () => {
    const prd = makePrd({
      reviewHistory: [
        blockerEntry([finding('缺 SSO 回调'), finding('批量导出权限缺失', 'major')], 1),
        rejectEntry('人工驳回: 见上轮', 2),
      ],
    })
    const ctx = extractRejectContext(prd)
    expect(ctx?.reason).toBe('人工驳回: 见上轮')
    // 只保留 blocker 级
    expect(ctx?.blockers.length).toBe(1)
    expect(ctx?.blockers[0].description).toBe('缺 SSO 回调')
  })

  it('reject + 上一轮无 blocker 级但有 findings → 回退展示全部', () => {
    const prd = makePrd({
      reviewHistory: [
        blockerEntry([finding('非关键项', 'minor')], 1),
        rejectEntry('人工驳回: 复查', 2),
      ],
    })
    const ctx = extractRejectContext(prd)
    expect(ctx?.blockers.length).toBe(1)
    expect(ctx?.blockers[0].severity).toBe('minor')
  })
})

describe('buildRejectSeedText', () => {
  it('无 reject entry 返回 null', () => {
    expect(buildRejectSeedText(makePrd({ reviewHistory: [] }))).toBeNull()
  })

  it('有 reject + blockers → 文本含 PRD 标题、版本、原因、blockers', () => {
    const prd = makePrd({
      id: 7,
      title: '订单导出',
      version: 3,
      reviewHistory: [
        blockerEntry([finding('缺 SSO 回调')]),
        rejectEntry('人工驳回: 登录态描述不清楚（by alice）'),
      ],
    })
    const text = buildRejectSeedText(prd)
    expect(text).toContain('PRD #7《订单导出》')
    expect(text).toContain('v3')
    expect(text).toContain('登录态描述不清楚')
    expect(text).toContain('缺 SSO 回调')
  })

  it('有 reject 无历史 blockers → 文本只含原因，不列 blockers 段', () => {
    const prd = makePrd({
      reviewHistory: [rejectEntry('人工驳回: 随便看看')],
    })
    const text = buildRejectSeedText(prd)
    expect(text).toContain('随便看看')
    expect(text).not.toContain('上一轮自审 blockers')
  })
})

describe('buildRejectSystemPromptAppendix', () => {
  it('非 drafting 状态返回 null', () => {
    const prd = makePrd({
      status: 'draft',
      reviewHistory: [rejectEntry('x')],
    })
    expect(buildRejectSystemPromptAppendix(prd)).toBeNull()
  })

  it('drafting + 最近 reject → 生成 Claude 可读 appendix', () => {
    const prd = makePrd({
      status: 'drafting',
      reviewHistory: [
        blockerEntry([finding('字段 A 未声明')]),
        rejectEntry('原因：不完整'),
      ],
    })
    const text = buildRejectSystemPromptAppendix(prd)
    expect(text).toContain('## 最近一次驳回')
    expect(text).toContain('不完整')
    expect(text).toContain('字段 A 未声明')
    expect(text).toContain('不要当新对话重开')
  })

  it('drafting + 末条不是 reject → null', () => {
    const prd = makePrd({
      status: 'drafting',
      reviewHistory: [blockerEntry([finding('x')])],
    })
    expect(buildRejectSystemPromptAppendix(prd)).toBeNull()
  })
})
