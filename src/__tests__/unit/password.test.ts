import { describe, it, expect } from 'vitest'
import { hashPassword, verifyPassword, validatePasswordStrength } from '../../admin/auth/password.js'

describe('password module', () => {
  it('hashPassword produces a bcrypt hash', async () => {
    const h = await hashPassword('secret12')
    expect(h).toMatch(/^\$2[ab]\$12\$/)
  })

  it('verifyPassword returns true for correct password', async () => {
    const h = await hashPassword('secret12')
    expect(await verifyPassword('secret12', h)).toBe(true)
  })

  it('verifyPassword returns false for wrong password', async () => {
    const h = await hashPassword('secret12')
    expect(await verifyPassword('wrong123', h)).toBe(false)
  })

  it('verifyPassword handles pgcrypto-generated $2a$ hashes', async () => {
    // Seed admin/admin uses pgcrypto, which produces $2a$ format.
    // Simulate by using a pre-computed $2a$ hash for 'admin'.
    const altHash = (await hashPassword('admin')).replace('$2b$', '$2a$')
    expect(await verifyPassword('admin', altHash)).toBe(true)
  })

  it('validatePasswordStrength accepts 8+ char mixed string', () => {
    expect(validatePasswordStrength('abc12345').ok).toBe(true)
  })

  it('validatePasswordStrength rejects length < 8', () => {
    const r = validatePasswordStrength('abc123')
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/长度/)
  })

  it('validatePasswordStrength rejects all-digit', () => {
    const r = validatePasswordStrength('12345678')
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/纯数字|全数字/)
  })
})
