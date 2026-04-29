import type { FastifyInstance } from 'fastify'
import {
  listPipelineSchedules,
  createPipelineSchedule,
  updatePipelineSchedule,
  deletePipelineSchedule,
} from '../../db/repositories/pipeline-schedules.js'
import { getTestPipelineById } from '../../db/repositories/test-pipelines.js'
import { validateTriggerParams } from '../../pipeline/validate-trigger-params.js'
import { reloadSchedules } from '../../pipeline/scheduler.js'

export async function registerPipelineScheduleRoutes(app: FastifyInstance): Promise<void> {
  // List schedules for a pipeline
  app.get<{ Params: { id: string } }>('/test-pipelines/:id/schedules', async (req, reply) => {
    const schedules = await listPipelineSchedules(Number(req.params.id))
    return reply.send(schedules)
  })

  // Create schedule
  app.post<{
    Params: { id: string }
    Body: { name?: string; cronExpr: string; presetParams?: Record<string, unknown>; enabled?: boolean }
  }>('/test-pipelines/:id/schedules', async (req, reply) => {
    const pipelineId = Number(req.params.id)
    const { name, cronExpr, presetParams = {}, enabled } = req.body

    const pipeline = await getTestPipelineById(pipelineId)
    if (!pipeline) return reply.status(404).send({ error: 'pipeline not found' })

    if (pipeline.paramSchema) {
      const check = validateTriggerParams(pipeline.paramSchema, presetParams)
      if (!check.valid) {
        return reply.status(400).send({ error: '预设参数不满足 paramSchema', missingFields: check.missingFields })
      }
    }

    const schedule = await createPipelineSchedule({ pipelineId, name, cronExpr, presetParams, enabled })
    await reloadSchedules()
    return reply.status(201).send(schedule)
  })

  // Update schedule
  app.put<{
    Params: { id: string; sid: string }
    Body: Partial<{ name: string; cronExpr: string; presetParams: Record<string, unknown>; enabled: boolean }>
  }>('/test-pipelines/:id/schedules/:sid', async (req, reply) => {
    const pipelineId = Number(req.params.id)
    const scheduleId = Number(req.params.sid)

    if (req.body.presetParams !== undefined) {
      const pipeline = await getTestPipelineById(pipelineId)
      if (pipeline?.paramSchema) {
        const check = validateTriggerParams(pipeline.paramSchema, req.body.presetParams)
        if (!check.valid) {
          return reply.status(400).send({ error: '预设参数不满足 paramSchema', missingFields: check.missingFields })
        }
      }
    }

    const updated = await updatePipelineSchedule(scheduleId, req.body)
    if (!updated) return reply.status(404).send({ error: 'schedule not found' })
    await reloadSchedules()
    return reply.send(updated)
  })

  // Delete schedule
  app.delete<{ Params: { id: string; sid: string } }>(
    '/test-pipelines/:id/schedules/:sid',
    async (req, reply) => {
      const ok = await deletePipelineSchedule(Number(req.params.sid))
      if (!ok) return reply.status(404).send({ error: 'schedule not found' })
      await reloadSchedules()
      return reply.status(204).send()
    },
  )

  // Toggle enabled
  app.patch<{ Params: { id: string; sid: string }; Body: { enabled: boolean } }>(
    '/test-pipelines/:id/schedules/:sid/toggle',
    async (req, reply) => {
      const updated = await updatePipelineSchedule(Number(req.params.sid), { enabled: req.body.enabled })
      if (!updated) return reply.status(404).send({ error: 'schedule not found' })
      await reloadSchedules()
      return reply.send(updated)
    },
  )
}
