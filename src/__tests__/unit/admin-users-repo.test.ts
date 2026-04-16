import { describe, it, expect, beforeEach } from 'vitest'
import { resetTestDb } from '../helpers/db.js'
import {
  getAdminUserByUsername,
  updateAdminPassword,
  updateAdminLastLogin,
} from '../../db/repositories/admin-users.js'

beforeEach(async () => { await resetTestDb() })

describe('admin-users repository', () => {
  it('returns seeded admin user', async () => {
    const user = await getAdminUserByUsername('admin')
    expect(user).not.toBeNull()
    expect(user!.username).toBe('admin')
    expect(user!.mustChangePassword).toBe(true)
    expect(user!.passwordHash).toMatch(/^\$2[ab]\$12\$/)
  })

  it('returns null for unknown user', async () => {
    const user = await getAdminUserByUsername('nobody')
    expect(user).toBeNull()
  })

  it('updateAdminPassword resets mustChangePassword to false', async () => {
    await updateAdminPassword('admin', '$2a$12$newhashvalueplaceholder00000000000000000000000000000000')
    const user = await getAdminUserByUsername('admin')
    expect(user!.mustChangePassword).toBe(false)
    expect(user!.passwordHash).toBe('$2a$12$newhashvalueplaceholder00000000000000000000000000000000')
  })

  it('updateAdminLastLogin sets last_login_at', async () => {
    const before = await getAdminUserByUsername('admin')
    expect(before!.lastLoginAt).toBeNull()
    await updateAdminLastLogin('admin')
    const after = await getAdminUserByUsername('admin')
    expect(after!.lastLoginAt).toBeInstanceOf(Date)
  })
})
