import type { FastifyPluginAsync } from 'fastify'
import {
  getPipelineBinding,
  listPipelineBindings,
  upsertPipelineBinding,
  deletePipelineBinding,
} from '../../db/repositories/pipeline-bindings.js'

export const pipelineBindingsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/pipeline-bindings', async (request) => {
    const q = request.query as { productLineId?: string; pipelineId?: string }
    const filter: { productLineId?: number; pipelineId?: number } = {}
    if (q.productLineId) filter.productLineId = Number(q.productLineId)
    if (q.pipelineId) filter.pipelineId = Number(q.pipelineId)
    return await listPipelineBindings(filter)
  })

  app.get('/pipeline-bindings/:productLineId/:refKey', async (request, reply) => {
    const p = request.params as { productLineId: string; refKey: string }
    const binding = await getPipelineBinding(Number(p.productLineId), p.refKey)
    if (!binding) { reply.code(404); return { error: 'not found' } }
    return binding
  })

  app.post('/pipeline-bindings', async (request) => {
    const b = request.body as {
      productLineId: number; refKey: string; pipelineId: number
      serverRoleAssignments?: Record<string, string[]>; description?: string
    }
    return await upsertPipelineBinding({
      productLineId: b.productLineId, refKey: b.refKey, pipelineId: b.pipelineId,
      serverRoleAssignments: b.serverRoleAssignments ?? {},
      description: b.description ?? '',
    })
  })

  app.delete('/pipeline-bindings/:productLineId/:refKey', async (request) => {
    const p = request.params as { productLineId: string; refKey: string }
    await deletePipelineBinding(Number(p.productLineId), p.refKey)
    return { ok: true }
  })
}
