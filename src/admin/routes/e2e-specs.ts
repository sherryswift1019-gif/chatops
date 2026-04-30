import type { FastifyInstance } from 'fastify'
import { listE2eSpecs, getE2eSpec, upsertE2eSpec, updateE2eSpecStatus } from '../../db/repositories/e2e-specs.js'
import { runPipelineA } from '../../e2e/pipeline-a/runner.js'

const VALID_STATUSES = ['pending', 'generating', 'pr_open', 'committed', 'baseline_failed', 'blocked_on_baseline_bug', 'skipped'] as const
type ValidStatus = typeof VALID_STATUSES[number]

export async function registerE2eSpecRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { projectId?: string } }>('/e2e-specs', async (req, reply) => {
    const { projectId } = req.query
    if (!projectId) return reply.status(400).send({ error: 'projectId required' })
    return reply.send(await listE2eSpecs(projectId))
  })

  app.post<{ Body: { targetProjectId: string; specPath: string; title: string; contentHash?: string } }>(
    '/e2e-specs',
    async (req, reply) => {
      const { targetProjectId, specPath, title, contentHash } = req.body
      if (!targetProjectId || !specPath || !title) {
        return reply.status(400).send({ error: 'targetProjectId, specPath, title required' })
      }
      const spec = await upsertE2eSpec({ targetProjectId, specPath, title, contentHash: contentHash ?? 'manual' })
      return reply.status(201).send(spec)
    },
  )

  app.post<{ Params: { id: string } }>('/e2e-specs/:id/generate', async (req, reply) => {
    const spec = await getE2eSpec(BigInt(req.params.id))
    if (!spec) return reply.status(404).send({ error: 'spec not found' })
    if (spec.generationStatus === 'generating') {
      return reply.status(409).send({ error: 'already generating' })
    }

    void runPipelineA({ targetProjectId: spec.targetProjectId, specPaths: [spec.specPath] }).catch((err) => {
      console.error('[e2e-specs:generate] Pipeline A error:', err)
      updateE2eSpecStatus(spec.id, 'baseline_failed').catch(() => {})
    })

    return reply.status(202).send({ message: 'generation started', specId: spec.id.toString() })
  })

  app.put<{ Params: { id: string }; Body: { generationStatus?: string; skip?: boolean } }>(
    '/e2e-specs/:id',
    async (req, reply) => {
      const spec = await getE2eSpec(BigInt(req.params.id))
      if (!spec) return reply.status(404).send({ error: 'not found' })

      if (req.body.skip) {
        await updateE2eSpecStatus(spec.id, 'skipped')
      } else if (req.body.generationStatus) {
        if (!VALID_STATUSES.includes(req.body.generationStatus as ValidStatus)) {
          return reply.status(400).send({ error: `invalid generationStatus: ${req.body.generationStatus}` })
        }
        await updateE2eSpecStatus(spec.id, req.body.generationStatus as ValidStatus)
      }
      return reply.send(await getE2eSpec(spec.id))
    },
  )
}
