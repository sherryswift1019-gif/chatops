// src/admin/routes/e2e-evidence.ts
import type { FastifyInstance } from 'fastify'
import { createReadStream } from 'fs'
import { stat, realpath } from 'fs/promises'
import { join, resolve } from 'path'
import { getEvidenceRoot } from '../../e2e/pipeline-b/evidence/storage.js'

export async function registerE2eEvidenceRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Params: { runId: string; scenarioId: string; attemptNumber: string; '*': string }
  }>('/e2e-runs/:runId/evidence/:scenarioId/:attemptNumber/*', async (req, reply) => {
    const { runId, scenarioId, attemptNumber } = req.params
    const filePath = req.params['*']

    if (!filePath) {
      return reply.status(400).send({ error: 'file path required' })
    }
    if (!/^\d+$/.test(runId)) return reply.status(400).send({ error: 'invalid runId' })
    if (!/^\d+$/.test(attemptNumber)) return reply.status(400).send({ error: 'invalid attemptNumber' })
    // scenarioId 允许含 `.`（pipeline-b 的 scenario ID 形如 `poc.smoke`）+ 字母数字 _ -
    if (!/^[a-zA-Z0-9_.-]+$/.test(scenarioId)) return reply.status(400).send({ error: 'invalid scenarioId' })

    const root = getEvidenceRoot()
    const fullPath = join(root, runId, scenarioId, attemptNumber, filePath)

    // realpath 防 symlink 越狱：把 root 和目标都解析到绝对路径再比对
    let resolvedRoot: string
    let resolvedFull: string
    try {
      resolvedRoot = await realpath(resolve(root))
      resolvedFull = await realpath(resolve(fullPath))
    } catch {
      return reply.status(404).send({ error: 'not found' })
    }
    if (!resolvedFull.startsWith(resolvedRoot + '/') && resolvedFull !== resolvedRoot) {
      return reply.status(400).send({ error: 'invalid path' })
    }

    try {
      const s = await stat(resolvedFull)
      if (!s.isFile()) return reply.status(404).send({ error: 'not found' })
    } catch {
      return reply.status(404).send({ error: 'not found' })
    }

    const ext = resolvedFull.split('.').pop()?.toLowerCase() ?? ''
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
      .send(createReadStream(resolvedFull))
  })
}
