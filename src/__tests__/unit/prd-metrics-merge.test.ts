/**
 * computeMergedMetrics 纯函数单测 —— 对应 src/db/repositories/prd-documents.ts。
 *
 * 不接 DB；只验证 patch 合并语义：
 *   - llmCallsDelta 是加法
 *   - reviewDurationMs / rulesVersion 是覆盖写
 *   - 空 patch 不变
 *   - 首次写入（existing 为空）能生成正确基线
 */

import { describe, it, expect } from 'vitest'
import { computeMergedMetrics } from '../../db/repositories/prd-documents.js'

describe('computeMergedMetrics', () => {
  it('首次写入：空 existing + llmCallsDelta → 直接落地为基线', () => {
    const out = computeMergedMetrics(
      {},
      { llmCallsDelta: { create: 1 }, rulesVersion: 'rules-v1' }
    )
    expect(out).toEqual({
      llmCalls: { create: 1 },
      rulesVersion: 'rules-v1',
    })
  })

  it('llmCallsDelta 是加法，不是覆盖', () => {
    const existing = { llmCalls: { create: 1, review: 2 } }
    const out = computeMergedMetrics(existing, {
      llmCallsDelta: { review: 3, repair: 1 },
    })
    expect(out.llmCalls).toEqual({ create: 1, review: 5, repair: 1 })
  })

  it('llmCallsDelta 不传的字段保持不变（不清零）', () => {
    const existing = { llmCalls: { create: 2, review: 1 } }
    const out = computeMergedMetrics(existing, {
      llmCallsDelta: { repair: 1 },
    })
    // create/review 原样保留、repair 新增
    expect(out.llmCalls).toEqual({ create: 2, review: 1, repair: 1 })
  })

  it('reviewDurationMs 是覆盖写（最近一次自审的总耗时）', () => {
    const existing = { reviewDurationMs: 5000 }
    const out = computeMergedMetrics(existing, { reviewDurationMs: 12000 })
    expect(out.reviewDurationMs).toBe(12000)
  })

  it('rulesVersion 是覆盖写', () => {
    const existing = { rulesVersion: 'rules-v1' }
    const out = computeMergedMetrics(existing, { rulesVersion: 'rules-v2' })
    expect(out.rulesVersion).toBe('rules-v2')
  })

  it('空 patch：不产生字段（existing 保持原样）', () => {
    const existing = { llmCalls: { create: 1 }, rulesVersion: 'rules-v1' }
    const out = computeMergedMetrics(existing, {})
    expect(out).toEqual(existing)
    // 不破坏引用以外的字段
    expect(out.llmCalls).toEqual({ create: 1 })
  })

  it('现有 llmCalls 非数字字段被忽略，不污染结果', () => {
    const existing = { llmCalls: { create: 'oops', review: 2 } }
    const out = computeMergedMetrics(existing, {
      llmCallsDelta: { create: 1 },
    })
    // create 当作 0，+1 → 1；review 保留
    expect(out.llmCalls).toEqual({ create: 1, review: 2 })
  })

  it('保留 existing 里的其他未知字段（前向兼容未来埋点）', () => {
    const existing = {
      llmCalls: { review: 1 },
      someFutureField: { foo: 'bar' },
    }
    const out = computeMergedMetrics(existing, {
      llmCallsDelta: { review: 1 },
    })
    expect(out.someFutureField).toEqual({ foo: 'bar' })
    expect(out.llmCalls).toEqual({ review: 2 })
  })

  it('多字段组合 patch：同时 delta + 覆盖 scalar', () => {
    const existing = { llmCalls: { create: 1, review: 1 } }
    const out = computeMergedMetrics(existing, {
      llmCallsDelta: { review: 2, repair: 1 },
      reviewDurationMs: 7000,
      rulesVersion: 'rules-v1',
    })
    expect(out).toEqual({
      llmCalls: { create: 1, review: 3, repair: 1 },
      reviewDurationMs: 7000,
      rulesVersion: 'rules-v1',
    })
  })

  it('全零 delta 不产生 llmCalls 字段（避免空对象污染）', () => {
    const out = computeMergedMetrics({}, { llmCallsDelta: {} })
    expect(out.llmCalls).toBeUndefined()
  })
})
