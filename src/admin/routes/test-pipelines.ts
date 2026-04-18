import type { FastifyInstance } from 'fastify'
import { listTestPipelines, getTestPipelineById, createTestPipeline, updateTestPipeline, deleteTestPipeline } from '../../db/repositories/test-pipelines.js'
import { getPool } from '../../db/client.js'
import { validateArtifactInputsForTrigger, mergePipelineForValidation } from './artifact-validation.js'
import type { ArtifactInput } from '../../pipeline/types.js'

// Auto-register/update a pipeline as a capability + enable for its product line
async function syncPipelineCapability(pipelineId: number, name: string, productLineId: number): Promise<void> {
  const pool = getPool()
  const key = `pipeline_${pipelineId}`
  const desc = `执行「${name}」流水线。使用autotest工具，参数: action=trigger_run, pipelineId=${pipelineId}。当用户说"执行${name}"、"运行${name}流水线"、"触发${name}测试"时匹配此能力。`
  await pool.query(
    `INSERT INTO capabilities (key, display_name, description, category, tool_names, needs_approval, param_schema, is_system)
     VALUES ($1, $2, $3, 'testing', '["autotest"]', false, '{}', false)
     ON CONFLICT (key) DO UPDATE SET display_name = $2, description = $3`,
    [key, `执行流水线: ${name}`, desc]
  )
  await pool.query(
    `INSERT INTO product_line_capabilities (product_line_id, capability_key, env_name, enabled, allowed_roles)
     VALUES ($1, $2, '*', true, '["developer","tester","ops","admin"]')
     ON CONFLICT (product_line_id, capability_key, env_name) DO NOTHING`,
    [productLineId, key]
  )
}

async function removePipelineCapability(pipelineId: number): Promise<void> {
  const pool = getPool()
  const key = `pipeline_${pipelineId}`
  await pool.query('DELETE FROM product_line_capabilities WHERE capability_key = $1', [key])
  await pool.query('DELETE FROM capabilities WHERE key = $1', [key])
}

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
    triggerParams?: Record<string, unknown>
    artifactInputs?: ArtifactInput[]
  } }>('/test-pipelines', async (req, reply) => {
    const { productLineId, name, stages, serverRoles, artifactInputs, schedule, triggerParams } = req.body
    if (!productLineId || !name || !stages || !serverRoles) {
      return reply.status(400).send({ error: 'productLineId, name, stages, serverRoles required' })
    }
    try {
      validateArtifactInputsForTrigger(artifactInputs ?? [], { schedule, triggerParams })
    } catch (e) {
      return reply.status(400).send({ error: (e as Error).message })
    }
    const item = await createTestPipeline(req.body)
    await syncPipelineCapability(item.id, item.name, item.productLineId)
    return reply.status(201).send(item)
  })

  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>('/test-pipelines/:id', async (req, reply) => {
    const id = Number(req.params.id)
    const existing = await getTestPipelineById(id)
    if (!existing) return reply.status(404).send({ error: 'not found' })

    const body = req.body as {
      artifactInputs?: ArtifactInput[]
      schedule?: string
      triggerParams?: Record<string, unknown>
    }
    const merged = mergePipelineForValidation(body, existing)
    try {
      validateArtifactInputsForTrigger(merged.artifactInputs, merged)
    } catch (e) {
      return reply.status(400).send({ error: (e as Error).message })
    }

    const item = await updateTestPipeline(id, req.body as any)
    if (!item) return reply.status(404).send({ error: 'not found' })
    await syncPipelineCapability(item.id, item.name, item.productLineId)
    return reply.send(item)
  })

  app.delete<{ Params: { id: string } }>('/test-pipelines/:id', async (req, reply) => {
    await removePipelineCapability(Number(req.params.id))
    const deleted = await deleteTestPipeline(Number(req.params.id))
    if (!deleted) return reply.status(404).send({ error: 'not found' })
    return reply.status(204).send()
  })
}
