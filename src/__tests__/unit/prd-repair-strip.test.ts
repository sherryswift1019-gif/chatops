/**
 * stripStructuredOnRepair 纯函数单测 —— 对应 src/agent/prd/prd-agent.ts。
 *
 * 目的：自修复路径写回 markdown 时必须把过时的 structuredPrd / rulesVersion 剥掉，
 * 避免 read-prd 仍以为这是一份 V2 PRD。见迭代文档 §10#8。
 */

import { describe, it, expect } from 'vitest'
import { stripStructuredOnRepair } from '../../agent/prd/prd-agent.js'

describe('stripStructuredOnRepair', () => {
  it('V2 PRD：剥掉 structuredPrd + rulesVersion，保留其他字段', () => {
    const out = stripStructuredOnRepair({
      phase: 'drafting',
      dialogueRounds: 3,
      structuredPrd: { meta: { title: 'x' } },
      rulesVersion: 'rules-v1',
      contextSummary: 'abc',
    })
    expect(out).toEqual({
      phase: 'drafting',
      dialogueRounds: 3,
      contextSummary: 'abc',
    })
    expect(out).not.toHaveProperty('structuredPrd')
    expect(out).not.toHaveProperty('rulesVersion')
  })

  it('V1 PRD：原本无 structuredPrd / rulesVersion → 返回 undefined（不触发 content_json 更新）', () => {
    const out = stripStructuredOnRepair({
      phase: 'drafting',
      dialogueRounds: 3,
    })
    expect(out).toBeUndefined()
  })

  it('只含 structuredPrd，没有 rulesVersion → 仍剥离', () => {
    const out = stripStructuredOnRepair({
      phase: 'drafting',
      structuredPrd: { meta: { title: 'x' } },
    })
    expect(out).toEqual({ phase: 'drafting' })
  })

  it('只含 rulesVersion，没有 structuredPrd → 仍剥离', () => {
    const out = stripStructuredOnRepair({
      phase: 'drafting',
      rulesVersion: 'rules-v1',
    })
    expect(out).toEqual({ phase: 'drafting' })
  })

  it('空 contentJson → undefined', () => {
    expect(stripStructuredOnRepair({})).toBeUndefined()
  })

  it('非对象 / null 输入 → undefined（防御）', () => {
    expect(stripStructuredOnRepair(null as unknown as Record<string, unknown>)).toBeUndefined()
    expect(
      stripStructuredOnRepair(undefined as unknown as Record<string, unknown>)
    ).toBeUndefined()
  })

  it('不产生对原对象的引用共享（保留的是字段值本身，非浅引用副作用）', () => {
    const nested = { deep: 'value' }
    const input = {
      phase: 'drafting',
      someNested: nested,
      structuredPrd: { x: 1 },
    }
    const out = stripStructuredOnRepair(input)!
    // 保留的嵌套字段内容仍一致（内部 key 原样转移即可，不要求深拷贝）
    expect(out.someNested).toBe(nested)
    // 但结果本身是新对象，不等于输入
    expect(out).not.toBe(input)
  })

  it('保留未来未知字段（前向兼容 content_json 扩展）', () => {
    const out = stripStructuredOnRepair({
      structuredPrd: { m: 1 },
      rulesVersion: 'rules-v1',
      futureField: { foo: 'bar' },
    })
    expect(out).toEqual({ futureField: { foo: 'bar' } })
  })
})
