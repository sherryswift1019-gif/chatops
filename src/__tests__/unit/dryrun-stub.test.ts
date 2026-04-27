import { describe, it, expect } from 'vitest'
import { generateStubFromSchema } from '../../pipeline/dryrun-stub.js'

describe('generateStubFromSchema', () => {
  it('string → ""', () => {
    expect(generateStubFromSchema({ type: 'string' })).toBe('')
  })

  it('number/integer → 0', () => {
    expect(generateStubFromSchema({ type: 'number' })).toBe(0)
    expect(generateStubFromSchema({ type: 'integer' })).toBe(0)
  })

  it('boolean → false', () => {
    expect(generateStubFromSchema({ type: 'boolean' })).toBe(false)
  })

  it('array → []（不递归 items）', () => {
    expect(generateStubFromSchema({ type: 'array', items: { type: 'string' } })).toEqual([])
  })

  it('object → 递归生成所有 properties', () => {
    expect(generateStubFromSchema({
      type: 'object',
      properties: {
        stdout: { type: 'string' },
        exitCode: { type: 'number' },
      },
    })).toEqual({ stdout: '', exitCode: 0 })
  })

  it('enum → 取首项', () => {
    expect(generateStubFromSchema({
      type: 'string', enum: ['approved', 'rejected', 'timeout'],
    })).toBe('approved')
  })

  it('type union [number, null] → number 默认值', () => {
    expect(generateStubFromSchema({ type: ['number', 'null'] })).toBe(0)
  })

  it('approval schema 完整', () => {
    expect(generateStubFromSchema({
      type: 'object',
      properties: {
        decision: { enum: ['approved', 'rejected', 'timeout'], type: 'string' },
        approver: { type: 'string' },
        comment: { type: 'string' },
      },
    })).toEqual({ decision: 'approved', approver: '', comment: '' })
  })

  it('http schema 完整（含嵌套 object）', () => {
    expect(generateStubFromSchema({
      type: 'object',
      properties: {
        statusCode: { type: 'number' },
        body: { type: 'object' },
        headers: { type: 'object' },
      },
    })).toEqual({ statusCode: 0, body: {}, headers: {} })
  })

  it('switch schema（matchedCaseIndex 是 nullable number）', () => {
    expect(generateStubFromSchema({
      type: 'object',
      properties: {
        matchedCaseIndex: { type: ['number', 'null'] },
        matchedTarget: { type: 'string' },
        matchedWhen: { type: ['string', 'null'] },
      },
    })).toEqual({ matchedCaseIndex: 0, matchedTarget: '', matchedWhen: '' })
  })
})
