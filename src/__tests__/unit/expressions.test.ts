import { describe, it, expect } from 'vitest'
import { evalExpression, parseExpression } from '../../pipeline/expressions.js'

describe('expressions — phase 3', () => {
  const ctx = {
    status: 'failed',
    output: { error: 'timeout', statusCode: 504, retries: 3 },
    steps: {
      a: { status: 'success', output: { count: 10 } },
    },
  }

  it('status == literal string', () => {
    expect(evalExpression("status == 'failed'", ctx)).toBe(true)
    expect(evalExpression("status == 'success'", ctx)).toBe(false)
  })

  it('output.<path> == literal', () => {
    expect(evalExpression("output.error == 'timeout'", ctx)).toBe(true)
    expect(evalExpression("output.statusCode == 504", ctx)).toBe(true)
    expect(evalExpression("output.statusCode != 200", ctx)).toBe(true)
  })

  it('numeric comparison', () => {
    expect(evalExpression("output.statusCode >= 500", ctx)).toBe(true)
    expect(evalExpression("output.statusCode < 500", ctx)).toBe(false)
    expect(evalExpression("output.retries > 2", ctx)).toBe(true)
  })

  it('contains operator', () => {
    expect(evalExpression("output.error contains 'time'", ctx)).toBe(true)
    expect(evalExpression("output.error contains 'permanent'", ctx)).toBe(false)
  })

  it('logical && / || / !', () => {
    expect(evalExpression("status == 'failed' && output.statusCode >= 500", ctx)).toBe(true)
    expect(evalExpression("status == 'success' || output.statusCode >= 500", ctx)).toBe(true)
    expect(evalExpression("!output.permanent", ctx)).toBe(true)
  })

  it('steps.<id>.output.<path>', () => {
    expect(evalExpression("steps.a.output.count > 5", ctx)).toBe(true)
    expect(evalExpression("steps.a.status == 'success'", ctx)).toBe(true)
  })

  it('parens', () => {
    expect(evalExpression("(status == 'failed') && (output.statusCode >= 500 || output.retries < 3)", ctx)).toBe(true)
  })

  it('parseExpression validates syntax', () => {
    expect(() => parseExpression("status ==")).toThrow(/parse/)
    expect(() => parseExpression("status @ 'failed'")).toThrow(/parse|operator/)
    expect(parseExpression("status == 'failed'")).toBeDefined() // 不抛
  })
})
