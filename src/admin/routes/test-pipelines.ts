import type { FastifyInstance } from 'fastify'
import { listTestPipelines, getTestPipelineById, createTestPipeline, updateTestPipeline, deleteTestPipeline } from '../../db/repositories/test-pipelines.js'

export async function registerTestPipelineRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { product_line_id?: string } }>('/test-pipelines', async (req, reply) => {
    const plId = req.query.product_line_id ? Number(req.query.product_line_id) : undefined
    return reply.send(await listTestPipelines(plId))
  })

  app.get<{ Params: { id: string } }>('/test-pipelines/:id', async (req, reply) => {
    const item = await getTestPipelineById(Number(req.params.id))
    if (!item) return reply.status(404).send({ error: 'not found' })
    return reply.send(item)
  })

  app.post<{ Body: {
    productLineId: number; name: string; description?: string
    stages: unknown[]; serverRoles: Record<string, { count: number }>
    schedule?: string; enabled?: boolean
  } }>('/test-pipelines', async (req, reply) => {
    const { productLineId, name, stages, serverRoles } = req.body
    if (!productLineId || !name || !stages || !serverRoles) {
      return reply.status(400).send({ error: 'productLineId, name, stages, serverRoles required' })
    }
    const item = await createTestPipeline(req.body)
    return reply.status(201).send(item)
  })

  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>('/test-pipelines/:id', async (req, reply) => {
    const item = await updateTestPipeline(Number(req.params.id), req.body as any)
    if (!item) return reply.status(404).send({ error: 'not found' })
    return reply.send(item)
  })

  app.delete<{ Params: { id: string } }>('/test-pipelines/:id', async (req, reply) => {
    const deleted = await deleteTestPipeline(Number(req.params.id))
    if (!deleted) return reply.status(404).send({ error: 'not found' })
    return reply.status(204).send()
  })
}
