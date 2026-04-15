import { describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { resetTestDb } from '../helpers/db.js'
import { sessionPlugin, requireAuth } from '../../admin/auth/session-plugin.js'
import { registerAuthRoutes } from '../../admin/routes/auth.js'

// Wrap with prefix '/admin' to mirror production adminPlugin mount.
async function buildApp() {
  const app = Fastify()
  await app.register(async (scope) => {
    await scope.register(sessionPlugin)
    scope.addHook('preHandler', requireAuth)
    await registerAuthRoutes(scope)
    scope.get('/protected', async () => ({ ok: true }))
  }, { prefix: '/admin' })
  return app
}

function extractCookie(headers: Record<string, unknown>): string {
  const raw = headers['set-cookie']
  if (Array.isArray(raw)) return raw.join('; ')
  return raw as string
}

beforeEach(async () => { await resetTestDb() })

describe('admin auth', () => {
  it('POST /admin/auth/login with correct credentials returns mustChangePassword=true', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/admin/auth/login',
      payload: { username: 'admin', password: 'admin' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ username: 'admin', mustChangePassword: true })
    expect(res.headers['set-cookie']).toBeDefined()
    await app.close()
  })

  it('POST /admin/auth/login with wrong password returns 401', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/admin/auth/login',
      payload: { username: 'admin', password: 'wrong123' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toMatchObject({ error: 'invalid_credentials' })
    await app.close()
  })

  it('POST /admin/auth/login with unknown user returns 401', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/admin/auth/login',
      payload: { username: 'nobody', password: 'x' },
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('GET /admin/auth/me without cookie returns 401', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/admin/auth/me' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('GET /admin/auth/me with valid cookie returns user', async () => {
    const app = await buildApp()
    const login = await app.inject({
      method: 'POST',
      url: '/admin/auth/login',
      payload: { username: 'admin', password: 'admin' },
    })
    const cookie = extractCookie(login.headers)
    const res = await app.inject({
      method: 'GET',
      url: '/admin/auth/me',
      headers: { cookie },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ username: 'admin', mustChangePassword: true })
    await app.close()
  })

  it('POST /admin/auth/change-password with wrong old password returns 401', async () => {
    const app = await buildApp()
    const login = await app.inject({
      method: 'POST',
      url: '/admin/auth/login',
      payload: { username: 'admin', password: 'admin' },
    })
    const cookie = extractCookie(login.headers)
    const res = await app.inject({
      method: 'POST',
      url: '/admin/auth/change-password',
      headers: { cookie },
      payload: { oldPassword: 'wrong', newPassword: 'newStrong1' },
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('POST /admin/auth/change-password with weak new password returns 400', async () => {
    const app = await buildApp()
    const login = await app.inject({
      method: 'POST',
      url: '/admin/auth/login',
      payload: { username: 'admin', password: 'admin' },
    })
    const cookie = extractCookie(login.headers)
    const res = await app.inject({
      method: 'POST',
      url: '/admin/auth/change-password',
      headers: { cookie },
      payload: { oldPassword: 'admin', newPassword: '1234' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: 'weak_password' })
    await app.close()
  })

  it('change-password success clears mustChangePassword and lets protected routes through', async () => {
    const app = await buildApp()
    const login = await app.inject({
      method: 'POST',
      url: '/admin/auth/login',
      payload: { username: 'admin', password: 'admin' },
    })
    const cookie = extractCookie(login.headers)
    // Before change: protected route blocked with 403 must_change_password
    const blocked = await app.inject({ method: 'GET', url: '/admin/protected', headers: { cookie } })
    expect(blocked.statusCode).toBe(403)

    const change = await app.inject({
      method: 'POST',
      url: '/admin/auth/change-password',
      headers: { cookie },
      payload: { oldPassword: 'admin', newPassword: 'newStrong1' },
    })
    expect(change.statusCode).toBe(200)

    // After change: same cookie can access protected
    const after = await app.inject({ method: 'GET', url: '/admin/protected', headers: { cookie } })
    expect(after.statusCode).toBe(200)
    await app.close()
  })

  it('POST /admin/auth/logout clears session', async () => {
    const app = await buildApp()
    const login = await app.inject({
      method: 'POST',
      url: '/admin/auth/login',
      payload: { username: 'admin', password: 'admin' },
    })
    const cookie = extractCookie(login.headers)
    const logout = await app.inject({ method: 'POST', url: '/admin/auth/logout', headers: { cookie } })
    expect(logout.statusCode).toBe(200)
    // Use the cookie from the logout response (session cleared by server)
    const logoutCookie = extractCookie(logout.headers)
    const me = await app.inject({ method: 'GET', url: '/admin/auth/me', headers: { cookie: logoutCookie } })
    expect(me.statusCode).toBe(401)
    await app.close()
  })

  it('unauthenticated access to protected route returns 401', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/admin/protected' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })
})
