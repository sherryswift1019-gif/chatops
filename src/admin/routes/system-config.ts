import type { FastifyInstance } from 'fastify'
import { getAllConfig, getConfig, setConfig } from '../../db/repositories/system-config.js'

const SECRET_FIELDS = /secret|password|token|key/i

function maskSecrets(value: Record<string, unknown>): Record<string, unknown> {
  const masked: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string' && SECRET_FIELDS.test(k) && v.length > 0) {
      masked[k] = '****' + v.slice(-4)
    } else {
      masked[k] = v
    }
  }
  return masked
}

export async function registerSystemConfigRoutes(app: FastifyInstance): Promise<void> {
  app.get('/system-config', async (_req, reply) => {
    const configs = await getAllConfig()
    const result = configs.map(c => ({
      key: c.key, value: maskSecrets(c.value), updatedAt: c.updatedAt,
    }))
    return reply.send(result)
  })

  // Export all configs (unmasked, for migration)
  app.get('/system-config/export', async (_req, reply) => {
    const configs = await getAllConfig()
    const result = configs.map(c => ({ key: c.key, value: c.value }))
    return reply
      .header('Content-Disposition', 'attachment; filename="chatops-config.json"')
      .header('Content-Type', 'application/json')
      .send(result)
  })

  // Import configs (bulk upsert)
  app.post<{ Body: Array<{ key: string; value: Record<string, unknown> }> }>(
    '/system-config/import',
    async (req, reply) => {
      const items = req.body
      if (!Array.isArray(items)) return reply.status(400).send({ error: 'body must be an array' })
      let count = 0
      for (const item of items) {
        if (item.key && item.value) {
          await setConfig(item.key, item.value)
          count++
        }
      }
      return reply.send({ success: true, imported: count })
    }
  )

  app.put<{ Params: { key: string }; Body: Record<string, unknown> }>(
    '/system-config/:key',
    async (req, reply) => {
      const { key } = req.params
      const newValue = req.body as Record<string, unknown>
      const existing = await getConfig(key)
      const merged: Record<string, unknown> = existing ? { ...existing.value } : {}
      for (const [k, v] of Object.entries(newValue)) {
        if (v !== '') merged[k] = v
      }
      const entry = await setConfig(key, merged)
      return reply.send({ key: entry.key, value: maskSecrets(entry.value), updatedAt: entry.updatedAt })
    }
  )
}
