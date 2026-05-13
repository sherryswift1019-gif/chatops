import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  answerBrainstormWaiter,
  getActiveBrainstormWaiterForRequirement,
  listBrainstormWaitersForRequirement,
} from '../../db/repositories/brainstorm-waiters.js'
import { resumeFromBrainstorm } from '../../pipeline/graph-runner.js'

const AnswerBodySchema = z
  .object({
    waiterId: z.number().int().positive().optional(),
    chosenOption: z.string().max(64).optional(),
    freeText: z.string().max(4096).optional(),
  })
  .refine(d => d.chosenOption || d.freeText, {
    message: 'one of chosenOption or freeText required',
  })

const MAX_ROUNDS_DEFAULT = 5

export async function registerBrainstormRoutes(app: FastifyInstance): Promise<void> {
  // GET state: front-end polling endpoint — returns { active, history }.
  app.get<{ Params: { id: string } }>(
    '/requirements/:id/brainstorm/state',
    async (req, reply) => {
      const requirementId = Number(req.params.id)
      if (!Number.isFinite(requirementId) || requirementId <= 0) {
        return reply.code(400).send({ error: 'invalid_requirement_id' })
      }

      const [active, allWaiters] = await Promise.all([
        getActiveBrainstormWaiterForRequirement(requirementId),
        listBrainstormWaitersForRequirement(requirementId),
      ])

      const history = allWaiters
        .filter(w => w.status === 'answered')
        .map(w => ({
          round: w.round,
          questionMd: w.questionMd,
          chosenOption: w.chosenOption,
          freeText: w.freeText,
          answeredAt: w.answeredAt?.toISOString() ?? null,
          source: w.source,
        }))

      return reply.send({
        active: active
          ? {
              waiterId: active.id,
              round: active.round,
              maxRounds: MAX_ROUNDS_DEFAULT,
              questionMd: active.questionMd,
              options: active.options,
              expiresAt: active.expiresAt.toISOString(),
            }
          : null,
        history,
      })
    },
  )

  // POST answer: write user response → race-claim UPDATE → resume graph.
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

      // If waiterId not provided, use the currently active waiter for this requirement.
      let waiterId = parsed.data.waiterId
      let activeOptions: { id: string; label: string }[] | null = null
      if (!waiterId) {
        const active = await getActiveBrainstormWaiterForRequirement(requirementId)
        if (!active) {
          return reply.code(404).send({ error: 'no_active_brainstorm_waiter' })
        }
        waiterId = active.id
        activeOptions = active.options
      } else {
        // Fetch waiter so we can validate chosenOption against options[]
        const active = await getActiveBrainstormWaiterForRequirement(requirementId)
        if (active && active.id === waiterId) {
          activeOptions = active.options
        }
      }

      // Validate chosenOption is one of the listed options (defense in depth — UI also constrains).
      if (parsed.data.chosenOption && activeOptions) {
        const valid = activeOptions.some(o => o.id === parsed.data.chosenOption)
        if (!valid) {
          return reply.code(400).send({
            error: 'invalid_option',
            allowed: activeOptions.map(o => o.id),
          })
        }
      }

      const answered = await answerBrainstormWaiter(waiterId, requirementId, {
        source: 'web',
        chosenOption: parsed.data.chosenOption ?? null,
        freeText: parsed.data.freeText ?? null,
      })
      if (!answered) {
        // race lost: another request (concurrent web / IM / timeout) already claimed.
        return reply.code(409).send({ error: 'already_answered' })
      }

      try {
        await resumeFromBrainstorm(answered)
      } catch (err) {
        req.log.error({ err, waiterId }, 'resumeFromBrainstorm failed')
        // waiter is already marked answered — return success; resume will be retried on next graph tick.
      }

      return reply.send({
        ok: true,
        round: answered.round,
        nextRound: answered.round + 1,
      })
    },
  )
}
