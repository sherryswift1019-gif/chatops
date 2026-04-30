// src/admin/routes/e2e-evidence.ts
import type { FastifyInstance } from 'fastify'
import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { join } from 'path'
import { E2E_EVIDENCE_ROOT_DEFAULT } from '../../e2e/pipeline-b/evidence/storage.js'

function getEvidenceRoot(): string {
  return process.env.E2E_EVIDENCE_ROOT ?? E2E_EVIDENCE_ROOT_DEFAULT
}

export async function registerE2eEvidenceRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Params: { runId: string; scenarioId: string; attemptNumber: string; '*': string }
  }>('/e2e-runs/:runId/evidence/:scenarioId/:attemptNumber/*', async (req, reply) => {
    const { runId, scenarioId, attemptNumber } = req.params
    const filePath = req.params['*']

    if (!filePath) {
      return reply.status(400).send({ error: 'file path required' })
    }

    const root = getEvidenceRoot()
    const fullPath = join(root, runId, scenarioId, attemptNumber, filePath)

    try {
      const s = await stat(fullPath)
      if (!s.isFile()) return reply.status(404).send({ error: 'not found' })
    } catch {
      return reply.status(404).send({ error: 'not found' })
    }

    const ext = fullPath.split('.').pop()?.toLowerCase() ?? ''
    const mimeMap: Record<string, string> = {
      txt: 'text/plain',
      log: 'text/plain',
      json: 'application/json',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      har: 'application/json',
    }
    const contentType = mimeMap[ext] ?? 'application/octet-stream'

    return reply
      .type(contentType)
      .send(createReadStream(fullPath))
  })
}
