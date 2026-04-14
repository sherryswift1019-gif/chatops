import type { FastifyInstance } from 'fastify'
import { listCapabilities, createCapability, updateCapability } from '../../db/repositories/capabilities.js'

export async function registerCapabilityRoutes(app: FastifyInstance): Promise<void> {
  app.get('/capabilities', async (_req, reply) => {
    return reply.send(await listCapabilities())
  })

  app.post<{ Body: { key: string; displayName: string; description?: string; category?: string; toolNames?: string[]; needsApproval?: boolean } }>(
    '/capabilities', async (req, reply) => {
      const { key, displayName, description, category, toolNames, needsApproval } = req.body
      if (!key || !displayName) return reply.status(400).send({ error: 'key and displayName required' })
      const item = await createCapability({
        key, displayName,
        description: description ?? '',
        category: (category ?? 'query') as 'query' | 'action' | 'admin',
        toolNames: toolNames ?? [],
        needsApproval: needsApproval ?? false,
      })
      return reply.status(201).send(item)
    }
  )

  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/capabilities/:id', async (req, reply) => {
      const item = await updateCapability(Number(req.params.id), req.body as any)
      if (!item) return reply.status(404).send({ error: 'not found' })
      return reply.send(item)
    }
  )
}
