// src/admin/routes/e2e-runs.ts
import type { FastifyInstance } from 'fastify'
import {
  getE2eRun,
  updateE2eRunStatus,
  listE2eRuns,
  countQueuedE2eRuns,
} from '../../db/repositories/e2e-runs.js'
import { listScenarioRuns } from '../../db/repositories/e2e-scenario-runs.js'
import { getSandboxByRunId } from '../../db/repositories/e2e-sandboxes.js'
import { runPipelineB } from '../../e2e/pipeline-b/runner.js'
import { loadScenariosFromGitlab } from '../../e2e/pipeline-b/playbook/load-from-gitlab.js'
import { buildInitialGovernorState, DEFAULT_GOVERNOR_LIMITS } from '../../e2e/pipeline-b/governor.js'
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

  app.get<{ Querystring: { projectId?: string; ref?: string } }>(
    '/e2e-runs/scenario-options',
    async (req, reply) => {
      const { projectId, ref } = req.query
      if (!projectId) return reply.status(400).send({ error: 'projectId required' })
      try {
        const loaded = await loadScenariosFromGitlab(projectId, ref)
        const allTags = [...new Set(loaded.scenarios.flatMap((s) => s.tags))].sort()
        return reply.send({ scenarios: loaded.scenarios, allTags, ref: loaded.ref })
      } catch (err) {
        return reply.status(502).send({
          error: 'gitlab_unavailable',
          message: err instanceof Error ? err.message : String(err),
        })
      }
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

    // 预检 maxQueuedRuns：runPipelineB 内部也会查，但那时 createE2eRun 已写入 DB row，
    // 失败后会留下 status='pending' 孤儿。提前在 admin POST 这一层挡住，
    // 让 caller 收到明确 4xx 而不是 202 + 后台 silent reject。
    const queuedCount = await countQueuedE2eRuns(targetProjectId)
    if (queuedCount >= DEFAULT_GOVERNOR_LIMITS.maxQueuedRuns) {
      return reply.status(429).send({
        error: 'too_many_queued_runs',
        message: `当前已有 ${queuedCount} 个 run 在等待，请稍后再试或 abort 现有 run（上限 ${DEFAULT_GOVERNOR_LIMITS.maxQueuedRuns}）`,
        queued: queuedCount,
        limit: DEFAULT_GOVERNOR_LIMITS.maxQueuedRuns,
      })
    }

    // 先 createE2eRun 拿 runId 立即返回；pipeline 在后台跑，避免 HTTP request
    // 阻塞几十分钟。错误由 runPipelineB 内部的 try/catch 写 e2e_runs.status='aborted'。
    // governorState 含 limits + 零计数器，详情页一开始就能展示静态 limits；runner 跑完
    // 会用最终内存版本（带最终 counters）覆盖回 DB。
    const governorState = buildInitialGovernorState(governorOverrides)
    const { createE2eRun } = await import('../../db/repositories/e2e-runs.js')
    const created = await createE2eRun({
      targetProjectId,
      triggerType: 'api',
      triggerActor: null,
      sourceBranch: sourceBranch ?? 'main',
      iterationBranch: '',
      scenarioFilter: scenarioFilter ?? null,
      governorState: governorState as unknown as Record<string, unknown>,
    })

    void runPipelineB({
      targetProjectId,
      sourceBranch: sourceBranch ?? 'main',
      scenarioFilter,
      triggerType: 'api',
      governorOverrides,
      existingRunId: created.id,
    }).catch((err) => {
      console.error(`[admin/e2e-runs] runPipelineB fire-and-forget failed runId=${created.id}:`, err)
      // 兜底：runPipelineB 没机会自己写 status='aborted' 时（极少数 init 阶段抛错），
      // 别让 createE2eRun 写的 row 留 'pending' 孤儿。runner.ts 内部 catch 会处理多数情况，
      // 这里是 last-resort 防御。
      updateE2eRunStatus(created.id, 'aborted', {
        abortReason: err instanceof Error ? err.message : String(err),
        finishedAt: new Date(),
      }).catch(() => undefined)
    })

    return reply.status(202).send({ runId: created.id.toString(), status: 'pending' })
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
