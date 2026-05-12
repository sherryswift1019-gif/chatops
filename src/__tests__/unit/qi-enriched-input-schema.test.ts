import { describe, it, expect } from 'vitest'
import { EnrichedInputSchema } from '../../quick-impl/enriched-input-schema.js'

describe('EnrichedInputSchema', () => {
  it('accepts a complete v1 input', () => {
    const valid = {
      schemaVersion: 'v1' as const,
      rawInput: '加个登录页',
      actors: { triggerer: 'PM', primaryUsers: ['访客'], verifier: 'QA' },
      objective: { userValue: '能登录', businessValue: '提升留存', successSignal: '登录后跳 /dashboard' },
      scope: { in: ['登录表单'], out: ['注册'] },
      noGos: [{ desc: '不存密码' }],
      historicalRefs: [{ description: '老登录页废弃', relation: 'deprecated' as const }],
      codebaseEvidence: [{ file: 'src/auth/login.ts', line: 42, purpose: '现有登录逻辑' }],
      conversationSummary: '用户要登录页',
      qaTurnCount: 3,
      partial: false,
    }
    expect(EnrichedInputSchema.parse(valid)).toEqual(valid)
  })

  it('rejects historicalRefs with unknown relation', () => {
    const invalid = {
      schemaVersion: 'v1', rawInput: 'x', actors: {}, objective: {},
      scope: { in: [], out: [] }, noGos: [], codebaseEvidence: [],
      conversationSummary: '', qaTurnCount: 0, partial: false,
      historicalRefs: [{ description: 'x', relation: 'unknown' }],
    }
    expect(() => EnrichedInputSchema.parse(invalid)).toThrow()
  })

  it('accepts partial=true with missingFields', () => {
    const partial = {
      schemaVersion: 'v1' as const, rawInput: 'x', actors: {}, objective: {},
      scope: { in: [], out: [] }, noGos: [], historicalRefs: [], codebaseEvidence: [],
      conversationSummary: '', qaTurnCount: 2, partial: true,
      missingFields: ['successSignal', 'verifier'],
    }
    expect(EnrichedInputSchema.parse(partial).missingFields).toEqual(['successSignal', 'verifier'])
  })
})
