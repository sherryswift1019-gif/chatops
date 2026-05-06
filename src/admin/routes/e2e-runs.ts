// src/admin/routes/e2e-runs.ts
import type { FastifyInstance } from 'fastify'
import * as bus from '../../e2e/pipeline-b/scenario-event-bus.js'
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
import { getDraft, approveDraft, updateDraftCommitInfo, getDraftByRunId, relinkDraftToNewRun } from '../../db/repositories/e2e-playbook-drafts.js'
import { commitPlaybookToGitlab } from '../../e2e/playbook-draft/commit-to-gitlab.js'
import { parsePlaybookYaml } from '../../e2e/pipeline-b/playbook/parse.js'
import {
  getPendingWebReview,
  submitWebReviewDecision,
} from '../../e2e/pipeline-b/web-review-waiter.js'
import type { HumanReviewDecision } from '../../e2e/pipeline-b/types.js'
import type { E2eRun } from '../../db/repositories/e2e-runs.js'
import type { E2eScenarioRun } from '../../db/repositories/e2e-scenario-runs.js'
import type { E2eSandbox } from '../../db/repositories/e2e-sandboxes.js'
import type { E2ePlaybookDraft } from '../../db/repositories/e2e-playbook-drafts.js'

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

// 详情页只用得上 mrUrl/committedPath/status，不返回 yamlContent / scenarioInput
// 这些大字段（前者 KB 级 YAML，后者用户输入），避免详情 payload 膨胀。
function serializeDraftSummary(draft: E2ePlaybookDraft | null): Record<string, unknown> | null {
  if (!draft) return null
  return {
    id: draft.id.toString(),
    status: draft.status,
    mrUrl: draft.mrUrl,
    committedPath: draft.committedPath,
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
    const [sandbox, scenarioRuns, playbookDraft] = await Promise.all([
      getSandboxByRunId(run.id),
      listScenarioRuns(run.id),
      getDraftByRunId(run.id),
    ])
    // 当 run 在等 web 审决策时，告诉前端等的是哪个 scenario_run（让 UI 决策按钮
    // 知道针对哪条记录），同时给出最近一次失败 attempt 的 manifest summary 让人看清。
    let awaitingReview: { scenarioRunId: string; scenarioId: string | null } | null = null
    if (run.status === 'awaiting_human_review') {
      const pending = getPendingWebReview(run.id)
      if (pending) {
        const sr = scenarioRuns.find((r) => r.id === pending.scenarioRunId)
        awaitingReview = {
          scenarioRunId: pending.scenarioRunId.toString(),
          scenarioId: sr?.scenarioId ?? null,
        }
      }
    }
    return reply.send({
      run: serializeRun(run),
      sandbox: serializeSandbox(sandbox),
      scenarioRuns: scenarioRuns.map(serializeScenarioRun),
      playbookDraft: serializeDraftSummary(playbookDraft),
      awaitingReview,
    })
  })

  app.post<{
    Body: {
      targetProjectId: string
      sourceBranch?: string
      playbookDraftId?: number | string
      scenarioFilter?: { ids?: string[]; tags?: string[] }
      governorOverrides?: { maxPerScenarioAttempts?: number; maxRunHours?: number; maxTotalAttempts?: number }
    }
  }>('/e2e-runs', async (req, reply) => {
    const { targetProjectId, sourceBranch, playbookDraftId, scenarioFilter, governorOverrides } = req.body
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

    // playbookDraftId 路径：校验 draft → 创 run → approveDraft → fire-and-forget
    if (playbookDraftId !== undefined && playbookDraftId !== null) {
      const draftBigInt = BigInt(playbookDraftId)
      const draft = await getDraft(draftBigInt)
      if (!draft) {
        return reply.status(404).send({ error: 'playbook draft not found' })
      }
      if (draft.status !== 'reviewing') {
        return reply.status(422).send({
          error: 'draft_not_ready',
          message: `playbook draft status is '${draft.status}', must be 'reviewing' to run`,
        })
      }
      if (!draft.yamlContent?.trim()) {
        return reply.status(422).send({ error: 'draft has no yaml content' })
      }

      const parseResult = parsePlaybookYaml(draft.yamlContent)
      if (!parseResult.ok) {
        return reply.status(422).send({
          error: 'invalid_playbook_yaml',
          message: parseResult.error,
          issues: parseResult.issues,
        })
      }

      const governorState = buildInitialGovernorState(governorOverrides)
      const { createE2eRun } = await import('../../db/repositories/e2e-runs.js')
      const created = await createE2eRun({
        targetProjectId,
        triggerType: 'manual_draft',
        triggerActor: null,
        sourceBranch: sourceBranch ?? 'main',
        iterationBranch: '',
        scenarioFilter: scenarioFilter ?? null,
        governorState: governorState as unknown as Record<string, unknown>,
      })

      await approveDraft(draftBigInt, created.id)

      // 同步预创建 SSE bus，消除"前端拿到 runId 立即 GET /events，但 runPipelineB
      // 还没第一次 emit → bus 不存在 → SSE 误报 closed"的 race。
      bus.ensureRun(created.id)

      void commitPlaybookToGitlab({
        targetProjectId,
        draftId: draftBigInt,
        yamlContent: draft.yamlContent ?? '',
        sourceBranch: sourceBranch ?? 'main',
        scenarioInput: draft.scenarioInput,
      }).then(({ mrUrl, committedPath }) =>
        updateDraftCommitInfo(draftBigInt, mrUrl, committedPath).catch(() => undefined),
      ).catch((err) => {
        console.warn(`[admin/e2e-runs] commitPlaybookToGitlab failed draftId=${draftBigInt}:`, err)
      })

      void runPipelineB({
        targetProjectId,
        sourceBranch: sourceBranch ?? 'main',
        scenarioFilter,
        playbookDraftId: draftBigInt,
        triggerType: 'api',
        governorOverrides,
        existingRunId: created.id,
      }).catch((err) => {
        console.error(`[admin/e2e-runs] runPipelineB (draft) fire-and-forget failed runId=${created.id}:`, err)
        updateE2eRunStatus(created.id, 'aborted', {
          abortReason: err instanceof Error ? err.message : String(err),
          finishedAt: new Date(),
        }).catch(() => undefined)
      })

      return reply.status(202).send({ runId: created.id.toString(), status: 'pending' })
    }

    // 原老路径（无 playbookDraftId）
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

    // 同步预创建 SSE bus，消除前端立即订阅时 runPipelineB 还没 emit 的 race。
    bus.ensureRun(created.id)

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

  app.post<{ Params: { id: string } }>('/e2e-runs/:id/rerun', async (req, reply) => {
    const oldRun = await getE2eRun(BigInt(req.params.id))
    if (!oldRun) return reply.status(404).send({ error: 'run not found' })

    // 复用 maxQueuedRuns 预检（仿现有 POST /e2e-runs）
    const queuedCount = await countQueuedE2eRuns(oldRun.targetProjectId)
    if (queuedCount >= DEFAULT_GOVERNOR_LIMITS.maxQueuedRuns) {
      return reply.status(429).send({
        error: 'too_many_queued_runs',
        message: `当前已有 ${queuedCount} 个 run 在等待，请稍后再试或 abort 现有 run（上限 ${DEFAULT_GOVERNOR_LIMITS.maxQueuedRuns}）`,
        queued: queuedCount,
        limit: DEFAULT_GOVERNOR_LIMITS.maxQueuedRuns,
      })
    }

    // manual_draft 的 run 反查 draft，拿到 draft.id 传给 runPipelineB（走 DB 路径，不重新调 LLM）
    let playbookDraftId: bigint | undefined
    if (oldRun.triggerType === 'manual_draft') {
      const draft = await getDraftByRunId(oldRun.id)
      if (draft) playbookDraftId = draft.id
    }

    const governorState = buildInitialGovernorState()
    const { createE2eRun } = await import('../../db/repositories/e2e-runs.js')
    const created = await createE2eRun({
      targetProjectId: oldRun.targetProjectId,
      triggerType: oldRun.triggerType,
      triggerActor: null,
      sourceBranch: oldRun.sourceBranch,
      iterationBranch: '',
      scenarioFilter: oldRun.scenarioFilter,
      governorState: governorState as unknown as Record<string, unknown>,
    })

    // 命中 draft 时，把 draft.e2e_run_id 重新指向新 run，
    // 让下次 rerun 仍能用 getDraftByRunId(newRunId) 命中（避免 chain 断）。
    if (playbookDraftId !== undefined) {
      await relinkDraftToNewRun(playbookDraftId, created.id).catch((err) => {
        console.warn(`[admin/e2e-runs] relinkDraftToNewRun failed draftId=${playbookDraftId}:`, err)
      })
    }

    void runPipelineB({
      targetProjectId: oldRun.targetProjectId,
      sourceBranch: oldRun.sourceBranch,
      scenarioFilter: oldRun.scenarioFilter as { ids?: string[]; tags?: string[] } | undefined ?? undefined,
      playbookDraftId,
      triggerType: 'api',
      existingRunId: created.id,
    }).catch((err) => {
      console.error(`[admin/e2e-runs] rerun runPipelineB failed runId=${created.id}:`, err)
      updateE2eRunStatus(created.id, 'aborted', {
        abortReason: err instanceof Error ? err.message : String(err),
        finishedAt: new Date(),
      }).catch(() => undefined)
    })

    return reply.status(202).send({ runId: created.id.toString(), status: 'pending' })
  })

  app.post<{
    Params: { runId: string }
    Body: { decision: HumanReviewDecision }
  }>('/e2e-runs/:runId/review-decision', async (req, reply) => {
    const decision = req.body?.decision
    if (decision !== 'approve' && decision !== 'retry' && decision !== 'reject') {
      return reply.status(400).send({
        error: 'invalid_decision',
        message: "decision must be one of 'approve' | 'retry' | 'reject'",
      })
    }

    const run = await getE2eRun(BigInt(req.params.runId))
    if (!run) return reply.status(404).send({ error: 'run not found' })
    if (run.status !== 'awaiting_human_review') {
      // 410 Gone 比 409/400 更准确：waiter 一旦消失就不会再回来（process restart /
      // 已被另一终端处理 / run 已离开 await gate）。
      return reply.status(410).send({
        error: 'not_awaiting_review',
        message: `run status is '${run.status}', no review pending`,
      })
    }

    const result = submitWebReviewDecision(run.id, decision)
    if (result === 'no_waiter') {
      return reply.status(410).send({
        error: 'no_waiter',
        message: 'no in-memory waiter (process restart or already submitted)',
      })
    }
    return reply.send({ ok: true, decision })
  })

  // SSE 实时进度流：连上时 replay history → 订阅后续 emit → 收到 closed 后服务端关流。
  // 鉴权自动走 src/admin/auth/session-plugin.ts:requireAuth（已经全局挂 preHandler）。
  // 参考 src/admin/routes/test-runs.ts SSE 模式：disconnect cleanup + ssePush try/catch + heartbeat。
  app.get<{ Params: { runId: string } }>('/e2e-runs/:runId/events', async (req, reply) => {
    let runId: bigint
    try {
      runId = BigInt(req.params.runId)
    } catch {
      return reply.status(400).send({ error: 'invalid runId' })
    }

    reply.raw.setHeader('Content-Type', 'text/event-stream')
    reply.raw.setHeader('Cache-Control', 'no-cache')
    reply.raw.setHeader('Connection', 'keep-alive')
    reply.raw.flushHeaders()

    let closed = false
    let unsub: () => void = () => { /* placeholder until subscribe */ }
    let heartbeat: NodeJS.Timeout | null = null

    const ssePush = (event: string, data: unknown): void => {
      if (closed) return
      try {
        reply.raw.write(`event: ${event}\n`)
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`)
      } catch { /* connection closed */ }
    }

    const cleanup = (): void => {
      if (closed) return
      closed = true
      try { unsub() } catch { /* ignore */ }
      if (heartbeat) clearInterval(heartbeat)
      try { reply.raw.end() } catch { /* ignore */ }
    }

    req.raw.on('close', cleanup)

    try {
      // replay history（剥 type 字段避免 data 内冗余）
      for (const ev of bus.getHistory(runId)) {
        const { type, ...payload } = ev
        ssePush(type, payload)
      }
      // live subscribe；bus 中收到 closed 时服务端主动关流
      unsub = bus.subscribe(runId, (ev) => {
        const { type, ...payload } = ev
        ssePush(type, payload)
        if (ev.type === 'closed') cleanup()
      })
      // heartbeat 30s 防 nginx idle 切流
      heartbeat = setInterval(() => ssePush('heartbeat', { ts: Date.now() }), 30000)
    } catch (err) {
      console.error('[SSE e2e-runs/events] handler init failed:', err)
      cleanup()
    }

    return reply
  })
}
