import type { FastifyInstance, FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import fp from 'fastify-plugin'
import secureSession from '@fastify/secure-session'
import { randomBytes } from 'crypto'
import { getConfig, setConfig } from '../../db/repositories/system-config.js'

const COOKIE_NAME = 'chatops_admin_session'
const SESSION_MAX_AGE = 60 * 60 * 24 * 7 // 7 days, seconds

// Whitelist paths that skip auth check (relative to /admin prefix).
const WHITELIST = [
  '/auth/login',
  '/auth/logout',
  '/auth/change-password',
  '/auth/me',  // /me is how the frontend probes; don't 401 it
]

declare module '@fastify/secure-session' {
  interface SessionData {
    username: string
    userId: number
  }
}

async function loadOrCreateSessionKey(): Promise<Buffer> {
  const existing = (await getConfig('session'))?.value as { key?: string } | undefined
  if (existing?.key) {
    return Buffer.from(existing.key, 'hex')
  }
  const newKey = randomBytes(32)
  await setConfig('session', { key: newKey.toString('hex') })
  return newKey
}

export const sessionPlugin: FastifyPluginAsync = fp(async (app: FastifyInstance) => {
  const key = await loadOrCreateSessionKey()
  await app.register(secureSession, {
    key,
    cookieName: COOKIE_NAME,
    cookie: {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: SESSION_MAX_AGE,
    },
  })
})

export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  // Strip /admin prefix before matching (route is mounted under /admin).
  const path = req.url.startsWith('/admin') ? req.url.slice('/admin'.length) : req.url
  const pathNoQuery = path.split('?')[0]
  if (WHITELIST.includes(pathNoQuery)) return
  // E2E 测试控制端点（仅在 E2E_MODE=1 时由 adminPlugin 注册，本身就是开关）
  if (process.env.E2E_MODE === '1' && pathNoQuery.startsWith('/_e2e/')) return

  const username = req.session.get('username')
  if (!username) {
    return reply.status(401).send({ error: 'not_authenticated' })
  }

  // must_change_password gate: except for change-password itself, block.
  const { getAdminUserByUsername } = await import('../../db/repositories/admin-users.js')
  const user = await getAdminUserByUsername(username)
  if (!user) {
    req.session.delete()
    return reply.status(401).send({ error: 'not_authenticated' })
  }
  if (user.mustChangePassword && pathNoQuery !== '/auth/change-password') {
    return reply.status(403).send({ error: 'must_change_password' })
  }
}
