/**
 * Quick-Impl Worker
 *
 * 两个后台任务：
 *
 * 1. queued-worker（每 30s 轮询）
 *    - SELECT requirements WHERE status='queued' LIMIT 1
 *    - 创建 test_run，调 startRun() 启动 quick-impl 流水线
 *    - 并发上限 QUICK_IMPL_CONCURRENCY（默认 2）
 *
 * 2. cleanup-worker（每 5min 轮询）
 *    - 扫 listLiveWorktrees()，找已终态的 requirements
 *    - 30 分钟宽限后 removeWorktree()
 *    - 清理前把 spec/plan 内容写回 DB（spec_content / plan_content）
 *
 * 设计：docs/prds/prd-quick-impl.md §8.1 / §11 / §12
 */
import { join } from 'path'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { getTestPipelineByName } from '../db/repositories/test-pipelines.js'
import { createTestRun, listRunningTestRuns, getTestRunById } from '../db/repositories/test-runs.js'
import {
  listRequirements,
  getRequirementById,
  setRequirementStatus,
  forceSetRequirementStatus,
  setSpecPlanContent,
  setPipelineRunId,
  isTerminalStatus,
  type RequirementStatus,
} from '../db/repositories/requirements.js'
import {
  listWaitersByRequirement,
  claimWaiter,
  getActiveWaiter,
} from '../db/repositories/requirement-approval-waiters.js'
import { startRun, resumeOrphanedRun, resumeFromQiApproval, type RunContext } from '../pipeline/graph-runner.js'
import { buildDefaultHooks } from '../pipeline/executor-hooks.js'
import { resolveDataDir } from '../pipeline/data-dir.js'
import {
  listLiveWorktrees,
  removeWorktree,
  WorktreeBusyError,
  WORKTREE_BASE_QI,
} from './worktree.js'
import {
  ensureBareRepo,
  removeBareBranch,
  listBareBranches,
  QI_LOCAL_REMOTE_BASE,
} from './qi-bare-repo.js'
import {
  QI_SANDBOX_DIR_BASE,
  parseSandboxDir,
  loadHandleFromSandbox,
  teardownQiSandbox,
} from './qi-sandbox.js'
import { QUICK_IMPL_PIPELINE_NAME } from './bootstrap.js'
import { createProductionSkillExecutor } from './skill-executor.js'
import type { PipelineGraph, StageDefinition } from '../pipeline/types.js'
import { linearizeStages } from '../pipeline/graph-migration.js'

const DATA_DIR = resolveDataDir()
const QUEUE_POLL_MS = 30_000
const CLEANUP_POLL_MS = 5 * 60_000
const CLEANUP_GRACE_MS = 30 * 60_000 // 30 min grace after terminal
/**
 * IM waiter 超时阈值：超过 24h 未 claim 的 qi_e2e_intervention / qi_sandbox_failed
 * waiter 视为人工介入超时，自动 claim 为 'aborted'。
 *
 * 注：waiter 表无 expires_at 列；用 created_at + 这个常量做 timeout 判断。
 * 这意味着所有 IM 介入用统一 24h 超时，im_input.timeoutSeconds 参数仅文档用。
 */
const QI_IM_WAITER_TIMEOUT_MS = 24 * 60 * 60_000

let queueTimer: ReturnType<typeof setInterval> | null = null
let cleanupTimer: ReturnType<typeof setInterval> | null = null
let running = false

export function startQuickImplWorker(): void {
  if (running) return
  running = true

  // Recover any runs that were interrupted by a previous server crash
  recoverInterruptedRuns().catch((err) => {
    console.error('[qi-worker] crash recovery error:', err)
  })

  queueTimer = setInterval(() => {
    runQueueTick().catch((err) => {
      console.error('[qi-worker] queue tick error:', err)
    })
  }, QUEUE_POLL_MS)

  cleanupTimer = setInterval(() => {
    runCleanupTick().catch((err) => {
      console.error('[qi-worker] cleanup tick error:', err)
    })
  }, CLEANUP_POLL_MS)

  console.log('[qi-worker] started (queue interval=30s, cleanup interval=5m)')
}

export function stopQuickImplWorker(): void {
  if (queueTimer) { clearInterval(queueTimer); queueTimer = null }
  if (cleanupTimer) { clearInterval(cleanupTimer); cleanupTimer = null }
  running = false
}

// ─── Crash recovery ───────────────────────────────────────────────────────────

const ACTIVE_STATUSES: RequirementStatus[] = [
  'spec_review', 'planning', 'developing', 'reviewing', 'testing', 'mr_pending',
]

/**
 * On startup, find requirements that were in-progress when the server last
 * crashed. Two cases:
 *
 * 1. Has an active (unclaimed) waiter → the pipeline was interrupted at an
 *    approval gate. Resume the pipeline run from its LangGraph checkpoint so
 *    the in-memory interrupt handler is re-armed; approving via Web will then
 *    resume correctly.
 *
 * 2. No waiter → crashed before the waiter was created (e.g. during spec
 *    generation). Reset status back to 'queued' so the worker picks it up on
 *    the next tick and restarts from scratch.
 *
 * Additionally, scan for "orphaned" running test_runs — runs with
 * status='running' that are no longer the requirement's active pipeline_run_id
 * (e.g. a new run was started after a crash, displacing the old one). If such
 * a run has a claimed (approved/rejected) waiter that was never applied, replay
 * it so dispatchInterrupt auto-resumes via the claimed-waiter shortcut.
 */
async function recoverInterruptedRuns(): Promise<void> {
  const { items } = await listRequirements({
    status: ACTIVE_STATUSES as unknown as RequirementStatus,
    size: 50,
  })

  // Build a set of active run IDs so we know which running test_runs are current
  const activeRunIds = new Set(items.map(r => r.pipelineRunId).filter((id): id is number => id != null))

  for (const req of items) {
    if (inFlight.has(req.id)) continue
    if (!req.pipelineRunId) {
      // No run yet — just reset to queued so the worker can pick it up
      await forceSetRequirementStatus(req.id, 'queued')
      console.log(`[qi-recovery] req #${req.id}: no pipelineRunId, reset to queued`)
      continue
    }

    // If the associated run already terminated (failed/cancelled/success), the
    // requirement status is stale — don't reset to queued (would re-run the
    // whole pipeline). Mark requirement failed so the user can decide manually.
    const associatedRun = await getTestRunById(req.pipelineRunId).catch(() => null)
    if (associatedRun && associatedRun.status !== 'running' && associatedRun.status !== 'pending') {
      const newStatus: RequirementStatus =
        associatedRun.status === 'success' ? 'merged' : 'failed'
      await forceSetRequirementStatus(req.id, newStatus)
      console.log(
        `[qi-recovery] req #${req.id}: run ${req.pipelineRunId} already ${associatedRun.status}, ` +
        `marking requirement ${newStatus} (was ${req.status})`,
      )
      continue
    }

    // Check if there's an active waiter (pipeline is at an approval gate)
    const waiters = await listWaitersByRequirement(req.id)
    const activeWaiter = waiters.find(w => !w.claimedBy)

    if (activeWaiter) {
      // Resume from checkpoint — re-arms the in-memory interrupt handler
      inFlight.add(req.id)
      resumeOrphanedRun(req.pipelineRunId)
        .catch(err => console.error(`[qi-recovery] req #${req.id} resume error:`, err))
        .finally(() => inFlight.delete(req.id))
      console.log(`[qi-recovery] req #${req.id}: waiter #${activeWaiter.id} pending, resuming run ${req.pipelineRunId}`)
    } else {
      // Crashed before waiter was created — reset to queued
      await forceSetRequirementStatus(req.id, 'queued')
      console.log(`[qi-recovery] req #${req.id}: no waiter, reset to queued (was ${req.status})`)
    }
  }

  // Also recover orphaned running test_runs: runs that are still 'running' in
  // the DB but whose requirement has moved on to a newer pipelineRunId. If the
  // orphaned run has a claimed waiter (decision recorded but graph never resumed),
  // replay it — dispatchInterrupt will detect the claimed waiter and auto-resume.
  const pipeline = await getTestPipelineByName(QUICK_IMPL_PIPELINE_NAME)
  if (!pipeline) return

  const runningRuns = await listRunningTestRuns(pipeline.id)
  for (const run of runningRuns) {
    if (activeRunIds.has(run.id)) continue  // already handled above
    // This run is no longer the active run for its requirement
    const waitersForRun = await listWaitersByRequirement(
      (run.triggerParams as Record<string, unknown>)?.requirementId as number,
    ).catch(() => [] as Awaited<ReturnType<typeof listWaitersByRequirement>>)
    // Look for a waiter belonging to this run that is claimed but the run is still 'running'
    const claimedWaiter = waitersForRun.find(
      w => w.pipelineRunId === run.id && w.claimedBy != null,
    )
    if (claimedWaiter) {
      console.log(`[qi-recovery] orphaned run ${run.id}: claimed waiter #${claimedWaiter.id} (${claimedWaiter.decision}), replaying`)
      void resumeOrphanedRun(run.id).catch(err =>
        console.error(`[qi-recovery] orphaned run ${run.id} replay error:`, err),
      )
    }
  }
}

// ─── Queued worker ────────────────────────────────────────────────────────────

const QUICK_IMPL_CONCURRENCY = Number(process.env.QUICK_IMPL_CONCURRENCY ?? 2)

/** In-memory set of requirement IDs currently being processed. */
const inFlight = new Set<number>()

async function runQueueTick(): Promise<void> {
  if (inFlight.size >= QUICK_IMPL_CONCURRENCY) return

  const pipeline = await getTestPipelineByName(QUICK_IMPL_PIPELINE_NAME)
  if (!pipeline) return

  const { items } = await listRequirements({ status: 'queued', size: QUICK_IMPL_CONCURRENCY })
  const slots = QUICK_IMPL_CONCURRENCY - inFlight.size
  const toStart = items.slice(0, slots).filter((r) => !inFlight.has(r.id))

  for (const req of toStart) {
    inFlight.add(req.id)
    launchPipeline(req.id, pipeline).finally(() => {
      inFlight.delete(req.id)
    })
  }
}

async function launchPipeline(
  requirementId: number,
  pipeline: Awaited<ReturnType<typeof getTestPipelineByName>>,
): Promise<void> {
  if (!pipeline) return
  const req = await getRequirementById(requirementId)
  if (!req) return
  if (req.status !== 'queued') return  // already picked up by another instance

  // Mark as in-progress so no double launch
  const advanced = await setRequirementStatus(requirementId, 'spec_review')
  if (!advanced) {
    // Status was not 'queued' anymore (race), skip
    return
  }

  const triggerParams: Record<string, unknown> = {
    requirementId: req.id,
    gitlabProject: req.gitlabProject,
    baseBranch: req.baseBranch,
    rawInput: req.rawInput,
    title: req.title,
    skipE2E: req.skipE2E,
  }

  const run = await createTestRun({
    pipelineId: pipeline.id,
    triggerType: 'api',
    triggeredBy: req.createdBy ?? 'quick-impl-worker',
    servers: {},
    triggerParams,
  })

  // Write pipeline_run_id back to requirement
  const { setPipelineRunId: _setPipelineRunId } = await import('../db/repositories/requirements.js')
  await _setPipelineRunId(requirementId, run.id)

  const logDir = join(DATA_DIR, String(run.id))
  const pipelineGraph = (pipeline.graph as PipelineGraph | null) ?? linearizeStages(pipeline.stages as StageDefinition[])
  const hooks = buildDefaultHooks(logDir)

  const ctx: RunContext = {
    runId: run.id,
    pipelineId: pipeline.id,
    stages: pipeline.stages as StageDefinition[],
    pipelineGraph,
    hooks,
    triggerParams,
    stageContext: {
      runId: run.id,
      servers: {},
      logDir,
      pipeline: { id: pipeline.id, name: pipeline.name },
      run: { id: run.id, triggeredBy: req.createdBy ?? 'quick-impl-worker', triggerType: 'api' },
      variables: { ...(pipeline.variables ?? {}) },
      skillExecutor: createProductionSkillExecutor(),
    },
  }

  console.log(`[qi-worker] launching pipeline run ${run.id} for requirement #${requirementId}`)
  startRun(ctx).then(async () => {
    // Node-level failures (return {status:'failed'}) don't reject the promise,
    // so the .catch below misses them. Reconcile requirement.status against
    // the final test_run.status: if pipeline ended 'failed' but requirement is
    // still in an active intermediate state (spec_review/planning/etc.), flip
    // it to 'failed' so the UI doesn't show a phantom "waiting for approval".
    try {
      const finalRun = await getTestRunById(run.id)
      if (finalRun?.status === 'failed') {
        const cur = await getRequirementById(requirementId)
        if (cur && cur.status !== 'failed' && cur.status !== 'aborted'
            && cur.status !== 'mr_open' && cur.status !== 'merged') {
          await setRequirementStatus(requirementId, 'failed' as RequirementStatus)
        }
      }
    } catch (err) {
      console.warn(`[qi-worker] post-run status reconcile failed for #${requirementId}:`, err)
    }
  }).catch((err) => {
    console.error(`[qi-worker] pipeline run ${run.id} error:`, err)
    setRequirementStatus(requirementId, 'failed' as RequirementStatus).catch(() => {})
  })
}

// ─── Cleanup worker ───────────────────────────────────────────────────────────

async function runCleanupTick(): Promise<void> {
  const liveWorktrees = await listLiveWorktrees()

  for (const wt of liveWorktrees) {
    const req = await getRequirementById(wt.requirementId).catch(() => null)
    if (!req) {
      // Requirement not found — probably deleted; clean immediately
      await safeRemoveWorktree(wt.requirementId, wt.retryAttempt, req)
      continue
    }

    if (!isTerminalStatus(req.status)) continue  // still running

    // Check grace period: completedAt + 30min
    const completedAt = req.completedAt
    if (!completedAt) continue
    const gracePassed = Date.now() - completedAt.getTime() >= CLEANUP_GRACE_MS
    if (!gracePassed) continue

    await saveSpecPlanSnapshot(req.id, wt.path)
    await safeRemoveWorktree(wt.requirementId, wt.retryAttempt, req)
  }

  // QI E2E Phase 2 扩展清理：bare repo branches + 孤儿 sandbox + IM waiter 超时
  await cleanupOrphanSandboxes().catch((err) => {
    console.warn('[qi-cleanup] sandbox cleanup error:', err)
  })
  await sweepExpiredImWaiters().catch((err) => {
    console.warn('[qi-cleanup] waiter sweep error:', err)
  })
}

async function saveSpecPlanSnapshot(requirementId: number, wtPath: string): Promise<void> {
  try {
    const specPath = join(wtPath, `docs/specs/qi-${requirementId}.md`)
    const planPath = join(wtPath, `docs/plans/qi-${requirementId}.md`)
    const specContent = existsSync(specPath) ? readFileSync(specPath, 'utf8') : null
    const planContent = existsSync(planPath) ? readFileSync(planPath, 'utf8') : null
    if (specContent || planContent) {
      await setSpecPlanContent(requirementId, specContent, planContent)
    }
  } catch (err) {
    console.warn(`[qi-cleanup] failed to snapshot spec/plan for req #${requirementId}:`, err)
  }
}

async function safeRemoveWorktree(
  requirementId: number,
  retryAttempt: number | undefined,
  req: Awaited<ReturnType<typeof getRequirementById>>,
): Promise<void> {
  try {
    const gitlabProject = req?.gitlabProject
    const cachePath = req?.worktreePath
      ? join(WORKTREE_BASE_QI, '..', `.chatops-repos-qi/${gitlabProject?.replace(/\//g, '-') ?? ''}`)
      : undefined
    await removeWorktree({ requirementId, retryAttempt, gitlabProject: gitlabProject ?? undefined, cachePath: cachePath ?? undefined })
    console.log(`[qi-cleanup] removed worktree for req #${requirementId}`)

    // 顺手清 bare repo 上的对应分支（per-project 共享 bare，不删 bare 目录本身）
    if (gitlabProject) {
      try {
        const bareRepoPath = await ensureBareRepo(gitlabProject)
        const branchName = retryAttempt && retryAttempt > 1
          ? `feat/qi-${requirementId}-r${retryAttempt}`
          : `feat/qi-${requirementId}`
        await removeBareBranch(bareRepoPath, branchName)
      } catch (err) {
        console.warn(`[qi-cleanup] failed to remove bare branch for req #${requirementId}:`, err)
      }
    }
  } catch (err) {
    if (err instanceof WorktreeBusyError) {
      // Lockfile still active — retry next tick
      return
    }
    console.warn(`[qi-cleanup] failed to remove worktree for req #${requirementId}:`, err)
  }
}

/**
 * 扫描 QI sandbox workspaces，对终态 +30min 的 requirement 关联的 sandbox 做 teardown。
 *
 * 路径格式：<QI_SANDBOX_DIR_BASE>/qi-<reqId>/attempt-<n>/。从路径反推 reqId，
 * 查 requirement 状态，终态且过宽限期则 deploy.sh teardown + rm -rf。
 *
 * 同时防御性扫 listBareBranches：发现某 bare branch 对应的 requirement 已终态 +30min，
 * 但 worktree cleanup 没把 ref 清掉（极少数 race），主动清。
 */
async function cleanupOrphanSandboxes(): Promise<void> {
  if (!existsSync(QI_SANDBOX_DIR_BASE)) return

  let entries: string[]
  try {
    entries = readdirSync(QI_SANDBOX_DIR_BASE)
  } catch {
    return
  }

  for (const reqDir of entries) {
    if (!reqDir.startsWith('qi-')) continue
    const reqIdStr = reqDir.slice(3)
    const reqId = parseInt(reqIdStr, 10)
    if (!Number.isFinite(reqId)) continue

    const reqPath = join(QI_SANDBOX_DIR_BASE, reqDir)
    let attemptDirs: string[]
    try {
      attemptDirs = readdirSync(reqPath)
    } catch {
      continue
    }

    for (const attemptDir of attemptDirs) {
      const sandboxDir = join(reqPath, attemptDir)
      const parsed = parseSandboxDir(sandboxDir)
      if (!parsed) continue

      const req = await getRequirementById(parsed.requirementId).catch(() => null)
      // requirement 不存在或仍在进行中 → 跳过
      if (!req) continue
      if (!isTerminalStatus(req.status)) continue
      if (!req.completedAt) continue
      if (Date.now() - req.completedAt.getTime() < CLEANUP_GRACE_MS) continue

      const handle = loadHandleFromSandbox(sandboxDir)
      if (!handle) {
        // handle 文件丢失，无法调 deploy.sh teardown；只能直接 rm
        try {
          statSync(sandboxDir) // 确保还在
          // 不抛错的 rm
          const { rmSync } = await import('fs')
          rmSync(sandboxDir, { recursive: true, force: true })
          console.log(`[qi-cleanup] removed orphan sandbox dir (no handle): ${sandboxDir}`)
        } catch { /* ignore */ }
        continue
      }

      try {
        await teardownQiSandbox(handle)
        console.log(`[qi-cleanup] tore down orphan sandbox req=${parsed.requirementId} attempt=${parsed.attempt}`)
      } catch (err) {
        console.warn(`[qi-cleanup] orphan teardown failed (req=${parsed.requirementId}):`, err)
      }
    }
  }
}

/**
 * 扫描超时未 claim 的 IM waiter（qi_e2e_intervention / qi_sandbox_failed），
 * 自动 claim 为 'aborted' 并 resume graph，避免 QI run 永久挂起。
 *
 * 用 created_at + QI_IM_WAITER_TIMEOUT_MS 做超时判定（waiter 表无 expires_at 列）。
 */
async function sweepExpiredImWaiters(): Promise<void> {
  // 简化实现：扫所有 in-progress requirement 的 active waiter
  const list = await listRequirements({}).catch(() => null)
  const reqs = list?.items ?? []
  const cutoff = Date.now() - QI_IM_WAITER_TIMEOUT_MS

  for (const req of reqs) {
    if (isTerminalStatus(req.status)) continue
    if (!req.currentStage) continue

    // currentStage 反查 active waiter；只关心 qi_e2e_intervention / qi_sandbox_failed
    const waiter = await getActiveWaiter(req.id, req.currentStage).catch(() => null)
    if (!waiter) continue
    if (waiter.decisionSet !== 'qi_e2e_intervention' && waiter.decisionSet !== 'qi_sandbox_failed') continue
    if (waiter.createdAt && waiter.createdAt.getTime() > cutoff) continue // 还未超时

    const result = await claimWaiter(waiter.id, 'abort', {
      decision: 'aborted',
      decidedBy: 'system-timeout',
      rejectReason: `IM waiter exceeded ${Math.round(QI_IM_WAITER_TIMEOUT_MS / 60_000)}min timeout`,
      budgetDelta: null,
    }).catch((err) => {
      console.warn(`[qi-cleanup] failed to timeout-claim waiter ${waiter.id}:`, err)
      return null
    })

    if (result?.claimed && result.waiter) {
      await resumeFromQiApproval(waiter.id, result.waiter).catch((err) => {
        console.warn(`[qi-cleanup] failed to resume after timeout claim waiter ${waiter.id}:`, err)
      })
      console.log(`[qi-cleanup] timed-out IM waiter ${waiter.id} req=#${req.id} → aborted`)
    }
  }
}
