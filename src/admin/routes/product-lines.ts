import type { FastifyInstance } from 'fastify'
import {
  listProductLines, createProductLine, updateProductLine, deleteProductLine,
} from '../../db/repositories/product-lines.js'
import { listMembers, addMember, updateMemberRole, removeMember } from '../../db/repositories/product-line-members.js'
import { getPool } from '../../db/client.js'
import { listProductLineEnvs, batchSetProductLineEnvs } from '../../db/repositories/product-line-envs.js'
import { getProductLineCapabilities, batchSetProductLineCapabilities } from '../../db/repositories/product-line-capabilities.js'
import {
  listProductLineIMTriggers,
  batchSetProductLineIMTriggers,
  type SetIMTriggerInput,
} from '../../db/repositories/product-line-im-triggers.js'

export async function registerProductLineRoutes(app: FastifyInstance): Promise<void> {
  app.get('/product-lines', async (_req, reply) => {
    return reply.send(await listProductLines())
  })

  app.post<{ Body: { name: string; displayName: string; description?: string } }>(
    '/product-lines', async (req, reply) => {
      const { name, displayName, description } = req.body
      if (!name || !displayName) return reply.status(400).send({ error: 'name and displayName are required' })
      const item = await createProductLine({ name, displayName, description: description ?? '' })
      // Auto-enable all capabilities for the new product line
      const pool = getPool()
      await pool.query(
        `INSERT INTO product_line_capabilities (product_line_id, capability_key, env_name, enabled, allowed_roles)
         SELECT $1, key, '*', true, '["developer","tester","ops","admin"]'
         FROM capabilities
         ON CONFLICT (product_line_id, capability_key, env_name) DO NOTHING`,
        [item.id]
      )
      return reply.status(201).send(item)
    }
  )

  app.put<{ Params: { id: string }; Body: { name?: string; displayName?: string; description?: string } }>(
    '/product-lines/:id', async (req, reply) => {
      const item = await updateProductLine(Number(req.params.id), req.body)
      if (!item) return reply.status(404).send({ error: 'not found' })
      return reply.send(item)
    }
  )

  app.delete<{ Params: { id: string } }>('/product-lines/:id', async (req, reply) => {
    const deleted = await deleteProductLine(Number(req.params.id))
    if (!deleted) return reply.status(404).send({ error: 'not found' })
    return reply.status(204).send()
  })

  // Members
  app.get<{ Params: { id: string } }>('/product-lines/:id/members', async (req, reply) => {
    return reply.send(await listMembers(Number(req.params.id)))
  })

  app.post<{ Params: { id: string }; Body: { userId: string; userName: string; role: string } }>(
    '/product-lines/:id/members', async (req, reply) => {
      const { userId, userName, role } = req.body
      if (!userId || !userName || !role) return reply.status(400).send({ error: 'userId, userName, role required' })
      const member = await addMember({
        productLineId: Number(req.params.id), userId, userName,
        role: role as 'developer' | 'ops' | 'admin',
      })
      return reply.status(201).send(member)
    }
  )

  app.put<{ Params: { id: string; memberId: string }; Body: { role: string } }>(
    '/product-lines/:id/members/:memberId', async (req, reply) => {
      const member = await updateMemberRole(Number(req.params.memberId), req.body.role as 'developer' | 'ops' | 'admin')
      if (!member) return reply.status(404).send({ error: 'not found' })
      return reply.send(member)
    }
  )

  app.delete<{ Params: { id: string; memberId: string } }>(
    '/product-lines/:id/members/:memberId', async (req, reply) => {
      const deleted = await removeMember(Number(req.params.memberId))
      if (!deleted) return reply.status(404).send({ error: 'not found' })
      return reply.status(204).send()
    }
  )

  // Envs
  app.get<{ Params: { id: string } }>('/product-lines/:id/envs', async (req, reply) => {
    return reply.send(await listProductLineEnvs(Number(req.params.id)))
  })

  app.put<{ Params: { id: string }; Body: Array<{ envId: number; runtime: string; namespace?: string; enabled?: boolean; connectionConfig?: Record<string, unknown>; defaultBranch?: string }> }>(
    '/product-lines/:id/envs', async (req, reply) => {
      const envs = req.body
      if (!Array.isArray(envs)) return reply.status(400).send({ error: 'body must be array' })
      try {
        const result = await batchSetProductLineEnvs(
          Number(req.params.id),
          envs.map(e => ({
            envId: e.envId,
            runtime: e.runtime as 'kubernetes' | 'docker',
            namespace: e.namespace,
            enabled: e.enabled,
            connectionConfig: e.connectionConfig,
            defaultBranch: e.defaultBranch,
          }))
        )
        return reply.send(result)
      } catch (err: unknown) {
        const e = err as Error & { statusCode?: number; duplicates?: Array<[number, number[]]> }
        if (e.statusCode === 400) return reply.status(400).send({ error: e.message, duplicates: e.duplicates })
        throw err
      }
    }
  )

  // Capabilities
  app.get<{ Params: { id: string } }>('/product-lines/:id/capabilities', async (req, reply) => {
    return reply.send(await getProductLineCapabilities(Number(req.params.id)))
  })

  app.put<{
    Params: { id: string }
    Body: Array<{
      capabilityKey: string
      envName: string
      enabled: boolean
      allowedRoles: string[]
      triggerSources?: string[]
    }>
  }>(
    '/product-lines/:id/capabilities', async (req, reply) => {
      const productLineId = Number(req.params.id)
      const caps = req.body
      if (!Array.isArray(caps)) return reply.status(400).send({ error: 'body must be array' })
      const result = await batchSetProductLineCapabilities(productLineId, caps)
      return reply.send(result)
    }
  )

  // IM Triggers (phase 2: schema-v32 product_line_im_triggers)
  app.get<{ Params: { id: string } }>('/product-lines/:id/im-triggers', async (req, reply) => {
    return reply.send(await listProductLineIMTriggers(Number(req.params.id)))
  })

  app.put<{ Params: { id: string }; Body: { items: SetIMTriggerInput[] } }>(
    '/product-lines/:id/im-triggers', async (req, reply) => {
      const items = req.body?.items
      if (!Array.isArray(items)) return reply.status(400).send({ error: 'body.items must be array' })
      await batchSetProductLineIMTriggers(Number(req.params.id), items)
      return reply.status(204).send()
    }
  )
}
