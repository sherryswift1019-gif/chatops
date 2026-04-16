import { describe, it, expect } from 'vitest'
import { mask } from '../../agent/masking/sensitive-info.js'

describe('SensitiveInfoMasker', () => {
  it('masks password fields in key=value format', () => {
    expect(mask('password=abc123')).toContain('[MASKED]')
    expect(mask('POSTGRES_PASSWORD=chatops')).toContain('[MASKED]')
    expect(mask('api_key=sk-1234567890')).toContain('[MASKED]')
  })

  it('masks IP addresses', () => {
    const result = mask('连接到 192.168.1.100 失败')
    expect(result).toContain('[MASKED_IP]')
    expect(result).not.toContain('192.168.1.100')
  })

  it('preserves localhost and 127.0.0.1', () => {
    expect(mask('localhost:3000')).toContain('localhost')
    expect(mask('127.0.0.1:5432')).toContain('127.0.0.1')
  })

  it('masks JWT tokens', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
    expect(mask(jwt)).toContain('[MASKED_JWT]')
  })

  it('masks Bearer tokens', () => {
    expect(mask('Authorization: Bearer sk-ant-api03-1234567890abcdef')).toContain('[MASKED_TOKEN]')
  })

  it('masks phone numbers', () => {
    expect(mask('联系人电话: 13812345678')).toContain('[MASKED_PHONE]')
  })

  it('returns plain text unchanged when no sensitive data', () => {
    const text = '这是一段普通文本，没有敏感信息'
    expect(mask(text)).toBe(text)
  })
})
