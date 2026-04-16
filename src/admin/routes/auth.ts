import type { FastifyInstance } from 'fastify'
import {
  getAdminUserByUsername,
  updateAdminPassword,
  updateAdminLastLogin,
} from '../../db/repositories/admin-users.js'
import { verifyPassword, hashPassword, validatePasswordStrength } from '../auth/password.js'

// Routes use PATHS RELATIVE to the adminPlugin mount point.
// adminPlugin is registered with { prefix: '/admin' } in server.ts,
// so '/auth/login' here becomes '/admin/auth/login' in production.
export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { username?: string; password?: string } }>(
    '/auth/login',
    async (req, reply) => {
      const { username, password } = req.body ?? {}
      if (!username || !password) {
        return reply.status(401).send({ error: 'invalid_credentials' })
      }
      const user = await getAdminUserByUsername(username)
      if (!user || !(await verifyPassword(password, user.passwordHash))) {
        return reply.status(401).send({ error: 'invalid_credentials' })
      }
      req.session.set('username', user.username)
      req.session.set('userId', user.id)
      await updateAdminLastLogin(user.username)
      return reply.send({ username: user.username, mustChangePassword: user.mustChangePassword })
    }
  )

  app.post('/auth/logout', async (req, reply) => {
    req.session.delete()
    return reply.send({ ok: true })
  })

  app.get('/auth/me', async (req, reply) => {
    const username = req.session.get('username')
    if (!username) return reply.status(401).send({ error: 'not_authenticated' })
    const user = await getAdminUserByUsername(username)
    if (!user) return reply.status(401).send({ error: 'not_authenticated' })
    return reply.send({ username: user.username, mustChangePassword: user.mustChangePassword })
  })

  app.post<{ Body: { oldPassword?: string; newPassword?: string } }>(
    '/auth/change-password',
    async (req, reply) => {
      const username = req.session.get('username')
      if (!username) return reply.status(401).send({ error: 'not_authenticated' })

      const { oldPassword, newPassword } = req.body ?? {}
      if (!oldPassword || !newPassword) {
        return reply.status(400).send({ error: 'missing_fields' })
      }

      const user = await getAdminUserByUsername(username)
      if (!user || !(await verifyPassword(oldPassword, user.passwordHash))) {
        return reply.status(401).send({ error: 'invalid_credentials' })
      }

      const strength = validatePasswordStrength(newPassword)
      if (!strength.ok) {
        return reply.status(400).send({ error: 'weak_password', reason: strength.reason })
      }

      const newHash = await hashPassword(newPassword)
      await updateAdminPassword(username, newHash)
      return reply.send({ ok: true })
    }
  )
}
