import { describe, it, expect } from 'vitest'
import { extractServersFromPayload, isValidServersShape } from '../../pipeline/webhook-payload.js'

describe('extractServersFromPayload', () => {
  it('从 body 取出 _servers 并从 payload 剔除', () => {
    const body = { _servers: { deploy: ['s1'] }, repo: 'foo' }
    const { servers, payload } = extractServersFromPayload(body)
    expect(servers).toEqual({ deploy: ['s1'] })
    expect(payload).toEqual({ repo: 'foo' })
    expect(payload).not.toHaveProperty('_servers')
  })

  it('无 _servers 时 servers 为 undefined', () => {
    const { servers, payload } = extractServersFromPayload({ a: 1 })
    expect(servers).toBeUndefined()
    expect(payload).toEqual({ a: 1 })
  })
})

describe('isValidServersShape', () => {
  it('合法 Record<string, string[]>', () => {
    expect(isValidServersShape({ deploy: ['s1', 's2'] })).toBe(true)
  })

  it('非 object 返回 false', () => {
    expect(isValidServersShape('foo')).toBe(false)
    expect(isValidServersShape(null)).toBe(false)
  })

  it('value 不是 string[] 返回 false', () => {
    expect(isValidServersShape({ deploy: 's1' })).toBe(false)
    expect(isValidServersShape({ deploy: [1, 2] })).toBe(false)
  })
})
