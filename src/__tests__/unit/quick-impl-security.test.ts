/**
 * Phase 5: rawInput 脱敏单测。
 * 设计：docs/prds/quick-impl-roles-v2/07-risks-ops.md §2.1
 */
import { describe, expect, it } from 'vitest'
import { sanitizeRawInput } from '../../quick-impl/security.js'

describe('sanitizeRawInput', () => {
  describe('GitLab token (glpat-)', () => {
    it('redacts a single token', () => {
      const r = sanitizeRawInput('clone with token glpat-AbCdEf1234567890_xyz1234')
      expect(r.sanitized).toBe('clone with token [REDACTED:gitlab-token]')
      expect(r.hits).toHaveLength(1)
      expect(r.hits[0]!.type).toBe('gitlab-token')
    })

    it('redacts multiple tokens', () => {
      const r = sanitizeRawInput('first glpat-AbCdEf1234567890_xyz1234 then glpat-XYZ1234567890_zzzzzz5678')
      expect(r.sanitized.match(/\[REDACTED:gitlab-token\]/g) ?? []).toHaveLength(2)
      expect(r.hits).toHaveLength(2)
    })

    it('does not redact short glpat-like strings', () => {
      const r = sanitizeRawInput('glpat-tiny')  // 太短，不命中
      expect(r.sanitized).toBe('glpat-tiny')
      expect(r.hits).toHaveLength(0)
    })
  })

  describe('API key (sk-)', () => {
    it('redacts Anthropic-style key', () => {
      const r = sanitizeRawInput('use sk-ant-AbCdEf1234567890XyZ1234567890')
      expect(r.sanitized).toContain('[REDACTED:api-key]')
      expect(r.hits.find(h => h.type === 'api-key')).toBeDefined()
    })
  })

  describe('Bearer token', () => {
    it('redacts Bearer with mixed case', () => {
      const r = sanitizeRawInput('curl -H "Authorization: Bearer abcDEF1234567890.xyz/=+~_-1234"')
      expect(r.sanitized).toContain('[REDACTED:bearer]')
    })
  })

  describe('email', () => {
    it('redacts by default', () => {
      const r = sanitizeRawInput('user is foo@example.com')
      expect(r.sanitized).toBe('user is [REDACTED:email]')
      expect(r.hits[0]!.type).toBe('email')
    })

    it('can be disabled via opts', () => {
      const r = sanitizeRawInput('user is foo@example.com', { disableEmail: true })
      expect(r.sanitized).toBe('user is foo@example.com')
      expect(r.hits.filter(h => h.type === 'email')).toHaveLength(0)
    })
  })

  describe('internal IP', () => {
    it('redacts 10.x.x.x', () => {
      const r = sanitizeRawInput('connect to 10.0.0.1 for db')
      expect(r.sanitized).toBe('connect to [REDACTED:internal-ip] for db')
    })

    it('redacts 192.168.x.x', () => {
      const r = sanitizeRawInput('docker host 192.168.1.100')
      expect(r.sanitized).toContain('[REDACTED:internal-ip]')
    })

    it('redacts 172.16-31.x.x', () => {
      const r = sanitizeRawInput('host 172.20.5.10')
      expect(r.sanitized).toContain('[REDACTED:internal-ip]')
    })

    it('does NOT redact 172.15.x.x (out of private range)', () => {
      const r = sanitizeRawInput('host 172.15.5.10')
      expect(r.sanitized).toBe('host 172.15.5.10')
    })

    it('does NOT redact 8.8.8.8 (public)', () => {
      const r = sanitizeRawInput('dns 8.8.8.8')
      expect(r.sanitized).toBe('dns 8.8.8.8')
    })
  })

  describe('multiple hits in one input', () => {
    it('all rules trigger together', () => {
      const r = sanitizeRawInput(
        'use glpat-AbCdEf1234567890_xyz1234 for foo@example.com on 10.0.0.5',
      )
      expect(r.sanitized).toContain('[REDACTED:gitlab-token]')
      expect(r.sanitized).toContain('[REDACTED:email]')
      expect(r.sanitized).toContain('[REDACTED:internal-ip]')
      expect(r.hits).toHaveLength(3)
    })
  })

  describe('safe inputs', () => {
    it('passthrough plain text', () => {
      const r = sanitizeRawInput('给登录页加记住密码 checkbox')
      expect(r.sanitized).toBe('给登录页加记住密码 checkbox')
      expect(r.hits).toHaveLength(0)
    })

    it('handles empty string', () => {
      const r = sanitizeRawInput('')
      expect(r.sanitized).toBe('')
      expect(r.hits).toHaveLength(0)
    })

    it('handles non-string gracefully', () => {
      // @ts-expect-error testing runtime safety
      const r = sanitizeRawInput(null)
      expect(r.hits).toHaveLength(0)
    })
  })

  describe('hit metadata', () => {
    it('records original length without exposing content', () => {
      const token = 'glpat-AbCdEf1234567890_xyz1234'
      const r = sanitizeRawInput(`token: ${token}`)
      expect(r.hits[0]!.originalLength).toBe(token.length)
      expect(r.hits[0]!.startIndex).toBe(7) // "token: " 长度 7
    })
  })
})
