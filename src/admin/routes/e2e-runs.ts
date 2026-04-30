// src/admin/routes/e2e-runs.ts
import type { FastifyInstance } from 'fastify'
import {
  getE2eRun,
  updateE2eRunStatus,
  listE2eRuns,
} from '../../db/repositories/e2e-runs.js'
import { listScenarioRuns } from '../../db/repositories/e2e-scenario-runs.js'
import { getSandboxByRunId } from '../../db/repositories/e2e-sandboxes.js'
import { runPipelineB } from '../../e2e/pipeline-b/runner.js'
import type { E2eRun } from '../../db/repositories/e2e-runs.js'
import type { E2eScenarioRun } from '../../db/repositories/e2e-scenario-runs.js'
import type { E2eSandbox } from '../../db/repositories/e2e-sandboxes.js'

function serializeRun(run: E2eRun): Record<string, unknown> {
  return { ...run, id: run.id.toString() }
}

function serializeScenarioRun(sr: E2eScenarioRun): Record<string, unknown> {
  return {
    ...sr,
    id: sr.id.toString(),
    e2eRunId: sr.e2eRunId.toString(),
    linkedBugReportId: sr.linkedBugReportId?.toString() ?? null,
  }
}

function serializeSandbox(sb: E2eSandbox | null): Record<string, unknown> | null {
  if (!sb) return null
  return {
    ...sb,
    id: sb.id.toString(),
    e2eRunId: sb.e2eRunId?.toString() ?? null,
  }
}

export async function registerE2eRunRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { projectId?: string; limit?: string; offset?: string } }>(
    '/e2e-runs',
    async (req, reply) => {
      const { projectId, limit, offset } = req.query
      const result = await listE2eRuns({
        projectId,
        limit: limit ? parseInt(limit, 10) : undefined,
        offset: offset ? parseInt(offset, 10) : undefined,
      })
      return reply.send({
        runs: result.runs.map(serializeRun),
        total: result.total,
      })
    },
  )

  app.get<{ Params: { runId: string } }>('/e2e-runs/:runId', async (req, reply) => {
    const run = await getE2eRun(BigInt(req.params.runId))
    if (!run) return reply.status(404).send({ error: 'run not found' })
    const [sandbox, scenarioRuns] = await Promise.all([
      getSandboxByRunId(run.id),
      listScenarioRuns(run.id),
    ])
    return reply.send({
      run: serializeRun(run),
      sandbox: serializeSandbox(sandbox),
      scenarioRuns: scenarioRuns.map(serializeScenarioRun),
    })
  })

  app.post<{
    Body: {
      targetProjectId: string
      sourceBranch?: string
      scenarioFilter?: { ids?: string[]; tags?: string[] }
      governorOverrides?: { maxPerScenarioAttempts?: number; maxRunHours?: number; maxTotalAttempts?: number }
    }
  }>('/e2e-runs', async (req, reply) => {
    const { targetProjectId, sourceBranch, scenarioFilter, governorOverrides } = req.body
    if (!targetProjectId) {
      return reply.status(400).send({ error: 'targetProjectId required' })
    }

    const { runId, status } = await runPipelineB({
      targetProjectId,
      sourceBranch: sourceBranch ?? 'main',
      scenarioFilter,
      triggerType: 'api',
      governorOverrides,
    })

    return reply.status(202).send({ runId: runId.toString(), status })
  })

  app.post<{ Params: { runId: string }; Body: { reason?: string } }>(
    '/e2e-runs/:runId/abort',
    async (req, reply) => {
      const run = await getE2eRun(BigInt(req.params.runId))
      if (!run) return reply.status(404).send({ error: 'run not found' })

      const abortReason = req.body.reason ?? 'user_abort'
      await updateE2eRunStatus(run.id, 'aborted', {
        finishedAt: new Date(),
        abortReason,
      })

      // TODO: teardownSandboxBestEffort + deleteRemoteBranchBestEffort 等 sandbox.ts/git-ops.ts 实现后替换
      console.warn('[e2e-runs:abort] sandbox teardown/branch-delete not yet implemented')

      return reply.send({ ok: true })
    },
  )
}
