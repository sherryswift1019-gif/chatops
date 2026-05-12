import type { FastifyInstance } from 'fastify'
import { existsSync, readFileSync } from 'fs'
import { rm } from 'fs/promises'
import { join } from 'path'
import {
  createRequirement,
  updateRequirement,
  deleteRequirement,
  forceDeleteRequirement,
  getRequirementById,
  listRequirements,
  setRequirementStatus,
  forceSetRequirementStatus,
  setSpecPlanContent,
  type RequirementStatus,
} from '../../db/repositories/requirements.js'
import {
  listWaitersByRequirement,
  getWaiterById,
  claimWaiter,
  type ApprovalDecision,
} from '../../db/repositories/requirement-approval-waiters.js'
import { resumeFromQiApproval, retryFailedRun, retryFromNode } from '../../pipeline/graph-runner.js'
import { getTestRunById, deleteTestRun } from '../../db/repositories/test-runs.js'
import { sanitizeRawInput, logSanitizeHits } from '../../quick-impl/security.js'

/** "http://host/group/repo(.git)" 或 "group/repo(.git)" → "group/repo" */
function normalizeProjectPath(input: string): string {
  let s = input.trim().replace(/\.git$/i, '')
  const m = s.match(/^https?:\/\/[^/]+\/(.+)$/i)
  if (m) s = m[1]
  return s.replace(/^\/+|\/+$/g, '')
}

export async function registerRequirementsRoutes(app: FastifyInstance): Promise<void> {
  // ── List ──────────────────────────────────────────────────────────────────
  app.get<{
    Querystring: { status?: string; page?: string; size?: string }
  }>('/requirements', async (req, reply) => {
    const { status, page, size } = req.query
    const statuses = status
      ? (status.split(',').filter(Boolean) as RequirementStatus[])
      : undefined
    const result = await listRequirements({
      status: statuses && statuses.length > 0 ? statuses : undefined,
      page: page ? Number(page) : undefined,
      size: size ? Number(size) : undefined,
    })
    return reply.send(result)
  })

  // ── Create (draft) ────────────────────────────────────────────────────────
  app.post<{
    Body: { title: string; rawInput: string; gitlabProject: string; baseBranch?: string; createdBy?: string; skipE2E?: boolean }
  }>('/requirements', async (req, reply) => {
    const { title, rawInput, gitlabProject, baseBranch, createdBy, skipE2E } = req.body
    if (!title || !rawInput || !gitlabProject) {
      return reply.status(400).send({ error: 'title, rawInput, and gitlabProject are required' })
    }
    // v2 §10.1: rawInput 入库前脱敏（GitLab token / API key / Bearer / 内网 IP / 邮箱）
    const sanitizeResult = sanitizeRawInput(rawInput)
    if (sanitizeResult.hits.length > 0) {
      logSanitizeHits(`POST /requirements (createdBy=${createdBy ?? 'anon'})`, sanitizeResult.hits)
    }
    const req_ = await createRequirement({
      title, rawInput: sanitizeResult.sanitized, gitlabProject: normalizeProjectPath(gitlabProject),
      baseBranch, source: 'web', createdBy, status: 'draft', skipE2E,
    })
    return reply.status(201).send(req_)
  })

  // ── Get detail ────────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/requirements/:id', async (req, reply) => {
    const id = Number(req.params.id)
    if (isNaN(id)) return reply.status(400).send({ error: 'invalid id' })
    const req_ = await getRequirementById(id)
    if (!req_) return reply.status(404).send({ error: 'not found' })
    const waiters = await listWaitersByRequirement(id)

    // Spec file fallback: DB spec_content is written by cleanup worker ~30min
    // after completion; read from worktree immediately if available.
    let specContent = req_.specContent
    if (!specContent && req_.worktreePath) {
      const specPath = join(req_.worktreePath, 'docs', 'specs', `qi-${id}.md`)
      if (existsSync(specPath)) {
        specContent = readFileSync(specPath, 'utf8')
        setSpecPlanContent(id, specContent, null).catch(() => {})
      }
    }

    // v2: 暴露最近一次 test_run 的 stage_results（含 v2 结构化字段
    // acceptanceCriteria / openQuestions / clarifications / risks / specCoverage / commits 等）
    let stageResults: unknown[] | null = null
    if (req_.pipelineRunId) {
      try {
        const tr = await getTestRunById(req_.pipelineRunId)
        stageResults = tr?.stageResults ?? null
      } catch {
        stageResults = null
      }
    }

    return reply.send({ ...req_, specContent, waiters, stageResults })
  })

  // ── Update (draft only) ───────────────────────────────────────────────────
  app.patch<{
    Params: { id: string }
    Body: { title?: string; rawInput?: string; gitlabProject?: string; baseBranch?: string; skipE2E?: boolean }
  }>('/requirements/:id', async (req, reply) => {
    const id = Number(req.params.id)
    if (isNaN(id)) return reply.status(400).send({ error: 'invalid id' })
    const body = { ...req.body }
    if (body.gitlabProject) body.gitlabProject = normalizeProjectPath(body.gitlabProject)
    // v2 §10.1: rawInput 更新前同样脱敏
    if (body.rawInput) {
      const sr = sanitizeRawInput(body.rawInput)
      if (sr.hits.length > 0) {
        logSanitizeHits(`PATCH /requirements/${id}`, sr.hits)
      }
      body.rawInput = sr.sanitized
    }
    const updated = await updateRequirement(id, body)
    if (!updated) {
      return reply.status(409).send({ error: 'requirement not found or not in draft status' })
    }
    return reply.send(updated)
  })

  // ── Delete (draft / queued / aborted) ────────────────────────────────────
  app.delete<{ Params: { id: string } }>('/requirements/:id', async (req, reply) => {
    const id = Number(req.params.id)
    if (isNaN(id)) return reply.status(400).send({ error: 'invalid id' })
    const req_ = await getRequirementById(id)
    if (!req_) {
      return reply.status(409).send({ error: 'requirement not found or already running (cannot delete)' })
    }
    if (req_.status === 'aborted') {
      if (req_.pipelineRunId) {
        await deleteTestRun(req_.pipelineRunId)
      }
      if (req_.worktreePath) {
        await rm(req_.worktreePath, { recursive: true, force: true }).catch(() => {})
      }
      await forceDeleteRequirement(id)
      return reply.status(204).send()
    }
    const deleted = await deleteRequirement(id)
    if (!deleted) {
      return reply.status(409).send({ error: 'requirement not found or already running (cannot delete)' })
    }
    return reply.status(204).send()
  })

  // ── Run: draft → queued, worker picks up within 30s ──────────────────────
  app.post<{ Params: { id: string } }>('/requirements/:id/run', async (req, reply) => {
    const id = Number(req.params.id)
    if (isNaN(id)) return reply.status(400).send({ error: 'invalid id' })
    const req_ = await getRequirementById(id)
    if (!req_) return reply.status(404).send({ error: 'not found' })
    if (req_.status !== 'draft') {
      return reply.status(409).send({ error: `cannot run: status is '${req_.status}', expected 'draft'` })
    }
    await setRequirementStatus(id, 'queued')
    const updated = await getRequirementById(id)
    return reply.send(updated)
  })

  // ── Abort: stop running requirement + unblock pipeline ────────────────────
  app.post<{ Params: { id: string } }>('/requirements/:id/abort', async (req, reply) => {
    const id = Number(req.params.id)
    if (isNaN(id)) return reply.status(400).send({ error: 'invalid id' })
    const req_ = await getRequirementById(id)
    if (!req_) return reply.status(404).send({ error: 'not found' })
    const NON_STOPPABLE: RequirementStatus[] = ['draft', 'merged', 'aborted', 'aborting', 'failed']
    if (NON_STOPPABLE.includes(req_.status as RequirementStatus)) {
      return reply.status(400).send({ error: `cannot stop requirement in status '${req_.status}'` })
    }
    await forceSetRequirementStatus(id, 'aborted', 'manually stopped by user')
    const waiters = await listWaitersByRequirement(id)
    const pending = waiters.filter(w => w.claimedBy === null)
    await Promise.all(
      pending.map(async (w) => {
        const result = await claimWaiter(w.id, 'web', { decision: 'aborted' })
        if (result.claimed) {
          await resumeFromQiApproval(w.id, result.waiter!)
        }
      }),
    )
    return reply.send({ success: true })
  })

  // ── Retry: 从失败节点 retry（resume 模式，Sub-plan E）─────────────────────
  // retryFailedRun 内部 fire-and-forget restartRunFromNode（QI pipeline 10+ min，HTTP
  // 客户端不能等）。sync 部分仍 throw on 校验失败 → 400；成功 → 202 async:true。
  app.post<{ Params: { id: string } }>('/requirements/:id/retry', async (req, reply) => {
    const id = Number(req.params.id)
    if (isNaN(id)) return reply.status(400).send({ error: 'invalid id' })

    const requirement = await getRequirementById(id)
    if (!requirement) return reply.status(404).send({ error: 'requirement not found' })

    if (!requirement.pipelineRunId) {
      return reply.status(400).send({
        error: 'requirement has no pipelineRunId; cannot retry (was never run?)',
      })
    }

    try {
      await retryFailedRun(requirement.pipelineRunId)
      return reply.status(202).send({ ok: true, retried: true, async: true })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return reply.status(400).send({ error: msg })
    }
  })

  // ── Retry from node: 从任意节点回退重跑（invalidate_downstream 模式，Sub-plan E.1）──
  // retryFromNode 同样 fire-and-forget restartRunFromNode。sync 部分 throw → 400；
  // sync 通过 → 202 async:true，graph 在后台跑。
  app.post<{
    Params: { id: string }
    Body: { fromNodeId: string }
  }>('/requirements/:id/retry-from-node', async (req, reply) => {
    const id = Number(req.params.id)
    if (isNaN(id)) return reply.status(400).send({ error: 'invalid id' })

    const fromNodeId = String(req.body?.fromNodeId ?? '').trim()
    if (!fromNodeId) {
      return reply.status(400).send({ error: 'fromNodeId is required in body' })
    }

    const requirement = await getRequirementById(id)
    if (!requirement) return reply.status(404).send({ error: 'requirement not found' })

    if (!requirement.pipelineRunId) {
      return reply.status(400).send({
        error: 'requirement has no pipelineRunId; cannot retry-from-node',
      })
    }

    try {
      await retryFromNode(requirement.pipelineRunId, fromNodeId)
      return reply.status(202).send({ ok: true, retriedFromNode: fromNodeId, async: true })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return reply.status(400).send({ error: msg })
    }
  })

  // ── Approval decision ─────────────────────────────────────────────────────
  app.post<{
    Params: { id: string; waiterId: string }
    Body: {
      decision: ApprovalDecision
      rejectReason?: string | null
      budgetDelta?: number | null
      decidedBy?: string | null
      targetTaskId?: string | null
      citedAiNotes?: string[] | null
    }
  }>('/requirements/:id/approvals/:waiterId', async (req, reply) => {
    const waiterId = Number(req.params.waiterId)
    if (isNaN(waiterId)) return reply.status(400).send({ error: 'invalid waiterId' })

    const { decision, rejectReason, budgetDelta, decidedBy, targetTaskId, citedAiNotes } = req.body
    if (!decision) return reply.status(400).send({ error: 'decision is required' })

    const existing = await getWaiterById(waiterId)
    if (!existing) return reply.status(404).send({ error: 'waiter not found' })
    if (existing.requirementId !== Number(req.params.id)) {
      return reply.status(400).send({ error: 'waiter does not belong to this requirement' })
    }

    const result = await claimWaiter(waiterId, 'web', {
      decision,
      rejectReason: rejectReason ?? null,
      budgetDelta: budgetDelta ?? null,
      decidedBy: decidedBy ?? (req.session.get('username') as string | undefined) ?? null,
      targetTaskId: targetTaskId ?? null,
      citedAiNotes: citedAiNotes ?? null,
    })

    if (!result.claimed) {
      return reply.status(409).send({ error: 'already claimed', claimedBy: result.by })
    }

    const resumed = await resumeFromQiApproval(waiterId, result.waiter!)
    return reply.send({ ok: true, resumed, waiter: result.waiter })
  })
}
