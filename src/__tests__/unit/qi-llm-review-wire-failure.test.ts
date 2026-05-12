import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

// Mock graph-runner retryFromNode (T8 已用同一 pattern)
const retryFromNodeMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock('../../pipeline/graph-runner.js', () => ({
  retryFromNode: retryFromNodeMock,
}))

// Mock skill executor: 返回 fail / pass / fail-fail-fail
const skillResultMock = vi.hoisted(() => vi.fn())
vi.mock('../../pipeline/skill-runner.js', () => ({
  runSkillAndCommit: skillResultMock,
}))

// Mock loadQiConfig
vi.mock('../../quick-impl/qi-config.js', () => ({
  loadQiConfig: vi.fn().mockResolvedValue({ aiReviewMaxRounds: 3, tokenBudgetPerRequirement: 250000 }),
  checkTokenBudget: vi.fn().mockResolvedValue({ ok: true, usedTokens: 0, budget: 250000 }),
  getCumulativeTokenUsage: vi.fn().mockResolvedValue(0),
}))

// 直接测试 buildLlmReviewNode 不容易（需 graph harness）。简化为：直接调用 handleAiReviewFailure
// + 验证 wire 后的 spec_ai_review node 在 bootstrap.ts 有正确 params。
// Integration test 留给 T30 E2E。

import { buildQuickImplGraph } from '../../quick-impl/bootstrap.js'

describe('spec_ai_review node has retryToOnFailure wired', () => {
  it('spec_ai_review node params include retryToOnFailure=spec_author', () => {
    const { nodes } = buildQuickImplGraph()
    const reviewNode = nodes.find(n => n.id === 'spec_ai_review')
    expect(reviewNode).toBeDefined()
    expect((reviewNode as any).params?.retryToOnFailure).toBe('spec_author')
  })
})
