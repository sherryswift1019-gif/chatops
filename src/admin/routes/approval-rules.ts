import type { FastifyInstance } from 'fastify'
import { getApprovalRules, insertApprovalRule, updateApprovalRule, deleteApprovalRule } from '../../db/repositories/approval-rules.js'

export async function registerApprovalRuleRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { product_line_id?: string } }>('/approval-rules', async (req, reply) => {
    const plId = req.query.product_line_id ? Number(req.query.product_line_id) : undefined
    return reply.send(await getApprovalRules(plId))
  })

  app.post<{ Body: { productLineId?: number; imTriggerKey: string; env: string; primaryApprovers: string[]; backupApprovers: string[]; primaryTimeoutMin: number; totalTimeoutMin: number } }>(
    '/approval-rules', async (req, reply) => {
      const { imTriggerKey, env, primaryApprovers, backupApprovers, primaryTimeoutMin, totalTimeoutMin, productLineId } = req.body
      if (!imTriggerKey || !env) return reply.status(400).send({ error: 'imTriggerKey and env required' })
      const rule = await insertApprovalRule({
        productLineId: productLineId ?? null, imTriggerKey, env,
        primaryApprovers: primaryApprovers ?? [], backupApprovers: backupApprovers ?? [],
        primaryTimeoutMin: primaryTimeoutMin ?? 10, totalTimeoutMin: totalTimeoutMin ?? 20,
      })
      return reply.status(201).send(rule)
    }
  )

  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/approval-rules/:id', async (req, reply) => {
      const rule = await updateApprovalRule(Number(req.params.id), req.body as any)
      if (!rule) return reply.status(404).send({ error: 'not found' })
      return reply.send(rule)
    }
  )

  app.delete<{ Params: { id: string } }>('/approval-rules/:id', async (req, reply) => {
    const deleted = await deleteApprovalRule(Number(req.params.id))
    if (!deleted) return reply.status(404).send({ error: 'not found' })
    return reply.status(204).send()
  })
}
