import type { FastifyInstance } from 'fastify'
import {
  listCapabilities,
  createCapability,
  updateCapability,
  updateCapabilitySystemPrompt,
  resetCapabilitySystemPrompt,
} from '../../db/repositories/capabilities.js'

export async function registerCapabilityRoutes(app: FastifyInstance): Promise<void> {
  app.get('/capabilities', async (_req, reply) => {
    return reply.send(await listCapabilities())
  })

  app.post<{ Body: { key: string; displayName: string; description?: string; toolNames?: string[]; category?: string } }>(
    '/capabilities', async (req, reply) => {
      const { key, displayName, description, toolNames, category } = req.body
      const VALID_CATEGORIES = ['feature_dev', 'bug_fix', 'ops', 'info_query']
      if (!key || !displayName) return reply.status(400).send({ error: 'key and displayName required' })
      if (category != null && !VALID_CATEGORIES.includes(category)) {
        return reply.status(400).send({ error: 'invalid category' })
      }
      const item = await createCapability({
        key, displayName,
        description: description ?? '',
        toolNames: toolNames ?? [],
        category: category ?? null,
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

  // 更新能力的系统提示词
  app.put<{ Params: { id: string }; Body: { systemPrompt: string } }>(
    '/capabilities/:id/system-prompt', async (req, reply) => {
      const { systemPrompt } = req.body
      if (typeof systemPrompt !== 'string') return reply.status(400).send({ error: 'systemPrompt required' })
      const item = await updateCapabilitySystemPrompt(Number(req.params.id), systemPrompt)
      if (!item) return reply.status(404).send({ error: 'not found' })
      return reply.send(item)
    }
  )

  // 恢复默认系统提示词
  app.post<{ Params: { id: string } }>(
    '/capabilities/:id/system-prompt/reset', async (req, reply) => {
      const item = await resetCapabilitySystemPrompt(Number(req.params.id))
      if (!item) return reply.status(404).send({ error: 'not found' })
      return reply.send(item)
    }
  )
}
