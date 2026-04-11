import type { FastifyInstance } from 'fastify'
import {
  listProductLines, createProductLine, updateProductLine, deleteProductLine,
} from '../../db/repositories/product-lines.js'
import { listMembers, addMember, updateMemberRole, removeMember } from '../../db/repositories/product-line-members.js'
import { listProductLineEnvs, batchSetProductLineEnvs } from '../../db/repositories/product-line-envs.js'

export async function registerProductLineRoutes(app: FastifyInstance): Promise<void> {
  app.get('/product-lines', async (_req, reply) => {
    return reply.send(await listProductLines())
  })

  app.post<{ Body: { name: string; displayName: string; description?: string } }>(
    '/product-lines', async (req, reply) => {
      const { name, displayName, description } = req.body
      if (!name || !displayName) return reply.status(400).send({ error: 'name and displayName are required' })
      const item = await createProductLine({ name, displayName, description: description ?? '' })
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

  app.put<{ Params: { id: string }; Body: Array<{ envId: number; runtime: string; namespace?: string; enabled?: boolean }> }>(
    '/product-lines/:id/envs', async (req, reply) => {
      const envs = req.body
      if (!Array.isArray(envs)) return reply.status(400).send({ error: 'body must be array' })
      const result = await batchSetProductLineEnvs(
        Number(req.params.id),
        envs.map(e => ({ envId: e.envId, runtime: e.runtime as 'kubernetes' | 'docker', namespace: e.namespace, enabled: e.enabled }))
      )
      return reply.send(result)
    }
  )
}
