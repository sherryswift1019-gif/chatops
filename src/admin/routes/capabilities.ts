import type { FastifyInstance } from 'fastify'
import {
  listCapabilities,
  createCapability,
  updateCapability,
  updateCapabilitySystemPrompt,
  resetCapabilitySystemPrompt,
  updateCapabilityPipelineBinding,
} from '../../db/repositories/capabilities.js'

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

  // 绑定/解绑 IM 触发时默认启动的 Pipeline
  app.put<{ Params: { id: string }; Body: { pipelineId: number | null } }>(
    '/capabilities/:id/pipeline-binding', async (req, reply) => {
      const { pipelineId } = req.body
      if (pipelineId !== null && typeof pipelineId !== 'number') {
        return reply.status(400).send({ error: 'pipelineId must be number or null' })
      }
      const item = await updateCapabilityPipelineBinding(Number(req.params.id), pipelineId)
      if (!item) return reply.status(404).send({ error: 'not found' })
      return reply.send(item)
    }
  )
}
