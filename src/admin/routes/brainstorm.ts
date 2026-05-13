import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

const AnswerBodySchema = z.object({
  chosenOption: z.string().optional(),
  freeText: z.string().optional(),
}).refine(d => d.chosenOption || d.freeText, {
  message: 'one of chosenOption or freeText required',
})

export async function registerBrainstormRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { id: string } }>(
    '/requirements/:id/brainstorm/answer',
    async (req, reply) => {
      const parsed = AnswerBodySchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'invalid_body',
          details: parsed.error.flatten(),
        })
      }
      const requirementId = Number(req.params.id)
      if (!Number.isFinite(requirementId) || requirementId <= 0) {
        return reply.code(400).send({ error: 'invalid_requirement_id' })
      }

      // Skeleton: brainstorm node is forward-compatible (T20).
      // Real resume path requires brainstorm-host LLM role and full interrupt.
      // For now, return 400 no_active_waiter — frontend handles gracefully.
      // TODO (post role.md sync): look up active interactive waiter, call resumeFromInteractiveInput.
      return reply.code(400).send({
        error: 'no_active_brainstorm_waiter',
        message: 'brainstorm interactive resume not yet wired (skeleton mode)',
      })
    },
  )
}
