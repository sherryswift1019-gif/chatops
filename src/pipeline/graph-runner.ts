/**
 * graph-runner — compile + stream + interrupt-dispatch runtime.
 *
 * Responsibility:
 *   - Rebuild the StateGraph from the current DB state (pipeline + stages)
 *   - Drive the graph via `graph.stream(input|Command, config)` with thread_id=runId
 *   - Reflect the merged state (stageResults / currentStageIndex) back to
 *     test_runs after each chunk
 *   - On interrupts, route to Task 3 adapters (approval-manager / webhook-waiter)
 *   - On END, run the finalize pipeline (report, zip, finishTestRun, release
 *     server locks, onComplete)
 *
 * Non-responsibility: graph structure (graph-builder), checkpoint storage
 * (graph-runtime), adapter details (approval-manager / webhook-waiter).
 */

import { join } from 'path'
import { Command } from '@langchain/langgraph'
import { getCheckpointer } from './graph-runtime.js'
import { createProductionSkillExecutor } from '../quick-impl/skill-executor.js'
import {
  buildGraphFromStages,
  buildGraphFromPipeline,
  APPROVAL_INTERRUPT,
  WEBHOOK_INTERRUPT,
  QI_APPROVAL_INTERRUPT,
  QI_IM_INPUT_INTERRUPT,
  type StageHooks,
  type StageContextBase,
  type ApprovalInterruptValue,
  type WebhookInterruptValue,
  type QiApprovalInterruptValue,
  type QiImInputInterruptValue,
  type QiApprovalResume,
} from './graph-builder.js'
import {
  getQiApprovalInfo,
  removeQiApprovalWaiter,
  registerQiApprovalWaiter,
} from './qi-approval-waiter.js'
import {
  type RequirementApprovalWaiter,
  getWaiterById,
} from '../db/repositories/requirement-approval-waiters.js'
import { linearizeStages } from './graph-migration.js'
import type { StageDefinition, ServerInfo, PipelineGraph } from './types.js'
import type { StageResult } from '../db/repositories/test-runs.js'
import { getTestPipelineById } from '../db/repositories/test-pipelines.js'
import {
  getTestRunById,
  finishTestRun,
} from '../db/repositories/test-runs.js'
import {
  mergeAndPersistStageResults,
  mergeAiAnalysisIntoStage,
} from './stage-status.js'
import { getProductLineById } from '../db/repositories/product-lines.js'
import {
  listTestServers,
  bulkSetServerStatus,
} from '../db/repositories/test-servers.js'
import { getDingTalkUserById } from '../db/repositories/dingtalk-users.js'
import { generateHtmlReport, generateZipArchive } from './report-generator.js'
import { analyzeFailure } from './failure-analyzer.js'
import { PipelineApprovalManager } from './approval-manager.js'
import { WebhookWaiter } from './webhook-waiter.js'
import { sendQiApprovalCard } from './qi-approval-manager.js'
import { buildDefaultHooks } from './executor-hooks.js'
import { resolveDataDir } from './data-dir.js'

// --- Public types -----------------------------------------------------------

export interface RunContext {
  runId: number
  pipelineId: number
  stageContext: StageContextBase
  stages: StageDefinition[]
  pipelineGraph?: PipelineGraph
  hooks: StageHooks
  triggerParams?: Record<string, unknown>
}

export interface FinalizeMeta {
  runId: number
  pipelineId: number
  pipelineName: string
  triggerType: 'manual' | 'api' | 'scheduled' | 'im'
  triggeredBy: string
  serverAssignment: Record<string, string[]>
  serverIds: number[]
  logDir: string
  startedAt: Date | null
  pipelineStartMs: number
  onComplete?: (result: PipelineRunResult) => void
}

export interface PipelineRunResult {
  runId: number
  pipelineName: string
  status: 'success' | 'failed'
  errorMessage: string
  stageResults: StageResult[]
  durationMs: number
}

// --- Registries -------------------------------------------------------------

const runRegistry = new Map<number, FinalizeMeta>()
// Timers tied to outstanding interrupts. Key = `${runId}:${stageIndex}`.
const interruptTimers = new Map<string, NodeJS.Timeout>()
// Keys already resolved this session — guards against an IM callback and a
// timeout both firing resumeRun in the same window.
const resolvedInterrupts = new Set<string>()

const interruptKey = (runId: number, stageIndex: number) => `${runId}:${stageIndex}`

function clearInterruptTimer(key: string): void {
  const t = interruptTimers.get(key)
  if (t) {
    clearTimeout(t)
    interruptTimers.delete(key)
  }
}

const DATA_DIR = resolveDataDir()

// --- Public entry points ----------------------------------------------------

/** Register finalize meta. Must be called before startRun. */
export function registerRunMeta(meta: FinalizeMeta): void {
  runRegistry.set(meta.runId, meta)
}

/**
 * Drop a run's FinalizeMeta without running the finalize pipeline. Intended
 * for the executor's error-recovery path: if startRun throws before the graph
 * enters its main try/catch (e.g. getCheckpointer() or graph.compile() throws
 * synchronously), finalize() never runs and the registry entry would leak.
 * The executor is responsible for finishTestRun + releasing server locks in
 * that case; this helper only cleans the in-memory meta + timers.
 */
export function purgeRunMeta(runId: number): void {
  runRegistry.delete(runId)
  for (const key of Array.from(resolvedInterrupts)) {
    if (key.startsWith(`${runId}:`)) resolvedInterrupts.delete(key)
  }
  for (const key of Array.from(interruptTimers.keys())) {
    if (key.startsWith(`${runId}:`)) clearInterruptTimer(key)
  }
}

/** Test-only helper: number of runs currently tracked in the meta registry. */
export function getRegistrySize(): number {
  return runRegistry.size
}

/**
 * Test-only helper: nuke every in-memory bookkeeping structure used by the
 * graph-runner module (runRegistry / resolvedInterrupts / interruptTimers).
 * Useful in test setup when prior tests in the same vitest worker may have
 * leaked entries that affect singleton-driven flows like approval/wait_webhook.
 */
export function resetGraphRunnerForTesting(): void {
  runRegistry.clear()
  resolvedInterrupts.clear()
  for (const t of interruptTimers.values()) clearTimeout(t)
  interruptTimers.clear()
}

/**
 * Start a pipeline run. Returns after the graph ENDs or hits its first
 * interrupt — in the latter case finalize is deferred until resumeRun drains
 * the rest.
 */
export async function startRun(ctx: RunContext): Promise<void> {
  await streamGraph(ctx, { runId: ctx.runId })
}

/**
 * Resume a pipeline run with a Command (from an IM approval callback, a
 * webhook delivery, or a timeout). Reloads pipeline/hooks from DB first.
 */
export async function resumeRun(runId: number, command: Command): Promise<void> {
  const ctx = await reloadContext(runId)
  if (!ctx) {
    console.warn(`[graph-runner] resumeRun: run ${runId} not resumable`)
    return
  }
  await streamGraph(ctx, command)
}

/**
 * Resume a pipeline run that was interrupted by a process crash (e.g. server
 * restart mid-execution). For QI_APPROVAL_INTERRUPT runs: reads the interrupt
 * value from the checkpoint and directly re-arms the in-memory waiter WITHOUT
 * re-streaming the graph (which would re-run earlier nodes from checkpoint).
 * If the waiter is already claimed (approved/rejected before restart), the
 * auto-resume path in dispatchInterrupt fires via setImmediate.
 *
 * For all other interrupt types: falls back to re-streaming (legacy path).
 */
export async function resumeOrphanedRun(runId: number): Promise<void> {
  const ctx = await reloadContext(runId)
  if (!ctx) {
    console.warn(`[graph-runner] resumeOrphanedRun: run ${runId} not resumable (no context)`)
    return
  }

  // Try to re-arm by reading the interrupt value from checkpoint directly.
  // This avoids re-streaming the graph (which would re-run nodes from the
  // interrupted checkpoint, overwriting already-completed stage results).
  const saver = await getCheckpointer()
  const graphBuilder = ctx.pipelineGraph
    ? buildGraphFromPipeline({
        graph: ctx.pipelineGraph,
        stageContext: ctx.stageContext,
        hooks: ctx.hooks,
        triggerParams: ctx.triggerParams,
      })
    : buildGraphFromStages({
        stages: ctx.stages,
        stageContext: ctx.stageContext,
        hooks: ctx.hooks,
        triggerParams: ctx.triggerParams,
      })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const compiled = (graphBuilder as any).compile({ checkpointer: saver })
  const config = { configurable: { thread_id: String(runId) } }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const snapshot: any = await compiled.getState(config).catch(() => null)

  if (snapshot) {
    const tasks = snapshot.tasks as Array<{ interrupts?: Array<{ value?: unknown }> }> | undefined
    if (Array.isArray(tasks)) {
      for (const task of tasks) {
        const interrupts = task.interrupts
        if (!Array.isArray(interrupts) || interrupts.length === 0) continue
        const value = interrupts[0]?.value
        if (!value || typeof value !== 'object') continue
        const type = (value as { type?: unknown }).type

        if (type === QI_APPROVAL_INTERRUPT || type === QI_IM_INPUT_INTERRUPT) {
          // Re-arm the in-memory handler directly — no re-stream needed.
          await dispatchInterrupt(ctx, value)
          console.log(`[graph-runner] resumeOrphanedRun: re-armed QI waiter (${type}) for run ${runId}`)
          return
        }
        // Other interrupt types: fall through to legacy stream path below.
        break
      }
    }
  }

  // Legacy path: non-QI interrupts (APPROVAL_INTERRUPT, WEBHOOK_INTERRUPT)
  // or graph has no checkpoint yet. Re-stream from current checkpoint.
  console.log(`[graph-runner] resuming orphaned run ${runId} from checkpoint (stream)`)
  await streamGraph(ctx, { runId })
}

/**
 * Wire resume handlers onto the Task 3 adapters. Call once at server startup
 * after PipelineApprovalManager.initialize().
 */
export function initGraphRunnerDispatchers(): void {
  // Shared early-return: if this interrupt was already resolved in this
  // session (by the counterpart race-winner), drop the duplicate.
  const claim = (runId: number, stageIndex: number): boolean => {
    const key = interruptKey(runId, stageIndex)
    if (resolvedInterrupts.has(key)) return false
    resolvedInterrupts.add(key)
    clearInterruptTimer(key)
    return true
  }
  PipelineApprovalManager.getInstance().setResumeHandler(
    async ({ runId, stageIndex, decision }) => {
      if (!claim(runId, stageIndex)) return
      await resumeRun(runId, new Command({ resume: decision }))
    },
  )
  WebhookWaiter.getInstance().setResumeHandler(
    async ({ runId, stageIndex, payload }) => {
      if (!claim(runId, stageIndex)) return
      await resumeRun(runId, new Command({ resume: payload }))
    },
  )
}

/**
 * Resume a skill_with_approval interrupt from an external approval claim.
 *
 * Called by the admin approval endpoint after successfully claiming a waiter.
 * Looks up the pending runId from the in-memory qi-approval-waiter registry,
 * bundles the claimed waiter + loopState into a QiApprovalResume, and calls
 * resumeRun to continue the graph.
 *
 * Returns true if the waiter was found and resume was dispatched; false if the
 * waiter is not registered (already resolved or never registered).
 */
export async function resumeFromQiApproval(
  waiterId: number,
  claimedWaiter: RequirementApprovalWaiter,
): Promise<boolean> {
  const info = getQiApprovalInfo(waiterId)
  if (!info) return false
  removeQiApprovalWaiter(waiterId)
  const resume: QiApprovalResume = {
    claimedWaiter,
    prevState: info.loopState,
  }
  // Fire-and-forget: the graph may run for minutes/hours; don't block the caller
  void resumeRun(info.runId, new Command({ resume })).catch(err =>
    console.error(`[graph-runner] resumeFromQiApproval run ${info.runId} error:`, err),
  )
  return true
}

// --- Core streaming loop ----------------------------------------------------

type InitialInput = { runId: number }

async function streamGraph(
  ctx: RunContext,
  inputOrCommand: InitialInput | Command,
): Promise<void> {
  const saver = await getCheckpointer()
  const graphBuilder = ctx.pipelineGraph
    ? buildGraphFromPipeline({
        graph: ctx.pipelineGraph,
        stageContext: ctx.stageContext,
        hooks: ctx.hooks,
        triggerParams: ctx.triggerParams,
      })
    : buildGraphFromStages({
        stages: ctx.stages,
        stageContext: ctx.stageContext,
        hooks: ctx.hooks,
        triggerParams: ctx.triggerParams,
      })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const compiled = (graphBuilder as any).compile({ checkpointer: saver })
  const config = { configurable: { thread_id: String(ctx.runId) } }

  try {
    // streamMode='values' → every chunk is the full merged state, which we
    // forward to mergeAndPersistStageResults. Interrupt chunks still arrive
    // as `{ __interrupt__: Interrupt[] }`.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stream = await compiled.stream(inputOrCommand as any, {
      ...config,
      streamMode: 'values',
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for await (const chunk of stream as AsyncIterable<any>) {
      await handleChunk(ctx, compiled, config, chunk)
    }
  } catch (err) {
    console.error(`[graph-runner] stream error for run ${ctx.runId}:`, err)
    await finalize(ctx, { fatalError: err instanceof Error ? err.message : String(err) })
    return
  }

  // Finalize iff the graph is at END (no pending tasks).
  const snapshot = await compiled.getState(config)
  if (!snapshot?.next || snapshot.next.length === 0) {
    await finalize(ctx)
  }
}

async function handleChunk(
  ctx: RunContext,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  compiled: any,
  config: Record<string, unknown>,
  chunk: unknown,
): Promise<void> {
  if (!chunk || typeof chunk !== 'object') return

  const interrupts = (chunk as { __interrupt__?: { value?: unknown }[] }).__interrupt__
  if (Array.isArray(interrupts) && interrupts.length > 0) {
    for (const it of interrupts) await dispatchInterrupt(ctx, it.value)
    // Persist authoritative state via getState (interrupt chunk has no values).
    const snap = await compiled.getState(config).catch(() => null)
    await persistValues(ctx, snap?.values ?? {})
    return
  }
  await persistValues(ctx, chunk as Record<string, unknown>)
}

async function persistValues(
  ctx: RunContext,
  values: Record<string, unknown>,
): Promise<void> {
  try {
    const stageResults = (values.stageResults ?? []) as StageResult[]
    const currentStage = (values.currentStageIndex ?? 0) as number
    // Merge instead of overwrite so DB-only running entries (written by
    // markStageRunning at node start, before langgraph state has any record)
    // survive each chunk. Finalized langgraph entries still overwrite running
    // DB entries by name — that's the desired stage-finish transition.
    await mergeAndPersistStageResults(ctx.runId, currentStage, stageResults)
  } catch (err) {
    console.warn(`[graph-runner] persistValues failed for run ${ctx.runId}:`, err)
  }
}

async function dispatchInterrupt(ctx: RunContext, value: unknown): Promise<void> {
  if (!value || typeof value !== 'object') return
  const v = value as { type?: string; stageIndex?: number }
  const key = interruptKey(ctx.runId, v.stageIndex ?? -1)
  // Clear any prior resolution mark (fresh interrupt at the same index).
  resolvedInterrupts.delete(key)
  clearInterruptTimer(key)

  if (v.type === APPROVAL_INTERRUPT) {
    const p = value as ApprovalInterruptValue
    const timeoutMs = (ctx.stages[p.stageIndex]?.timeoutSeconds ?? 3600) * 1000
    try {
      await PipelineApprovalManager.getInstance().requestCard({
        runId: ctx.runId,
        stageIndex: p.stageIndex,
        approverIds: p.approverIds,
        description: p.description,
      })
    } catch (err) {
      console.error(`[graph-runner] requestCard failed for run ${ctx.runId}:`, err)
    }
    scheduleTimeout(ctx.runId, p.stageIndex, timeoutMs, new Command({ resume: 'timeout' }))
    return
  }

  if (v.type === WEBHOOK_INTERRUPT) {
    const p = value as WebhookInterruptValue
    const timeoutMs = (ctx.stages[p.stageIndex]?.timeoutSeconds ?? 3600) * 1000
    try {
      WebhookWaiter.getInstance().register(p.tag, ctx.runId, p.stageIndex)
    } catch (err) {
      console.error(`[graph-runner] waiter.register failed for run ${ctx.runId}:`, err)
    }
    scheduleTimeout(ctx.runId, p.stageIndex, timeoutMs, new Command({ resume: { timeout: true } }))
    return
  }

  if (v.type === QI_APPROVAL_INTERRUPT) {
    const p = value as QiApprovalInterruptValue
    registerQiApprovalWaiter(p.waiterId, { runId: ctx.runId, loopState: p.loopState })

    // After server restart: waiter may already be claimed — resume immediately.
    getWaiterById(p.waiterId).then(w => {
      if (w?.claimedBy) {
        setImmediate(() => {
          resumeFromQiApproval(p.waiterId, w).catch(err =>
            console.error(`[graph-runner] auto-resume claimed waiter ${p.waiterId} failed:`, err),
          )
        })
      }
    }).catch(() => {})

    // 向钉钉审批人发互动卡片（approverIds 为空则静默跳过，仅 Web 审批）
    if (p.approverIds.length > 0) {
      sendQiApprovalCard({
        waiterId: p.waiterId,
        requirementId: p.requirementId,
        requirementTitle: p.requirementTitle,
        contextSummary: p.contextSummary,
        imSummary: p.imSummary ?? null,
        approvalKind: p.approvalKind,
        decisionSet: p.decisionSet,
        approverIds: p.approverIds,
      }).catch(err => {
        console.error(`[graph-runner] sendQiApprovalCard failed for waiterId=${p.waiterId}:`, err)
      })
    }
    return
  }

  if (v.type === QI_IM_INPUT_INTERRUPT) {
    const p = value as QiImInputInterruptValue
    // im_input 复用 qi-approval-waiter 注册机制，但 loopState 不需要（单次 interrupt）
    registerQiApprovalWaiter(p.waiterId, { runId: ctx.runId, loopState: { budgetUsed: 0, rejectHistory: [] } })

    // 重启后 waiter 可能已被 claim → 立即 resume
    getWaiterById(p.waiterId).then(w => {
      if (w?.claimedBy) {
        setImmediate(() => {
          resumeFromQiApproval(p.waiterId, w).catch(err =>
            console.error(`[graph-runner] auto-resume im_input waiter ${p.waiterId} failed:`, err),
          )
        })
      }
    }).catch(() => {})

    if (p.approverIds.length > 0) {
      sendQiApprovalCard({
        waiterId: p.waiterId,
        requirementId: p.requirementId,
        requirementTitle: p.requirementTitle,
        contextSummary: p.contextSummary,
        approvalKind: p.kind, // 'qi_e2e_intervention' | 'qi_sandbox_failed'
        approverIds: p.approverIds,
      }).catch(err => {
        console.error(`[graph-runner] sendQiApprovalCard (im_input) failed for waiterId=${p.waiterId}:`, err)
      })
    }
    return
  }
}

function scheduleTimeout(
  runId: number,
  stageIndex: number,
  timeoutMs: number,
  command: Command,
): void {
  const key = interruptKey(runId, stageIndex)
  const timer = setTimeout(() => {
    // Guard against late-firing timers: if the run has already finalized (not
    // in the registry), or this interrupt was resolved by a race-winner (IM
    // callback / webhook), or finalize purged the timers under us — drop the
    // fire. Without this the callback would call resumeRun → reloadContext,
    // which may return null or run against stale DB state and emit noise.
    if (!runRegistry.has(runId)) {
      interruptTimers.delete(key)
      return
    }
    if (resolvedInterrupts.has(key)) return
    resolvedInterrupts.add(key)
    interruptTimers.delete(key)
    resumeRun(runId, command).catch((err) => {
      console.error(`[graph-runner] timeout resume failed for run ${runId}:`, err)
    })
  }, timeoutMs)
  // Don't pin the Node process alive.
  if (typeof timer.unref === 'function') timer.unref()
  interruptTimers.set(key, timer)
}

// --- Finalize ---------------------------------------------------------------

/** Fold stageResults into a single (status, errorMessage) tuple.
 *
 * onFailure: 'continue' 的 stage 失败不应让整个 run 失败 —— pipeline 设计上把这类 fail
 * 当作正常分支信号（典型用例：plan_review_loop AI 审失败 → escalate 到 human）。
 * 仅当某个 onFailure='stop' (默认) 的 stage 失败时才把 run 标 failed。
 */
function summarizeStatus(
  stageResults: StageResult[],
  stages: StageDefinition[],
  fatalError?: string,
): { status: 'success' | 'failed'; errorMessage: string } {
  // Fatal errors (compile / stream throws before any stage finished) must
  // surface as failed even when stageResults is empty — otherwise the run
  // is reported success despite never executing.
  if (fatalError) {
    return { status: 'failed', errorMessage: fatalError }
  }
  for (let i = 0; i < stageResults.length; i++) {
    const r = stageResults[i]
    if (r.status !== 'failed') continue
    const stage = stages[i]
    // 默认 onFailure='stop'；显式 'continue' 时容忍失败（pipeline 已自行 escalate 到下游 stage）
    if (stage?.onFailure === 'continue') continue
    return {
      status: 'failed',
      errorMessage: `Stage "${r.name}" failed: ${r.error ?? r.output ?? ''}`,
    }
  }
  return { status: 'success', errorMessage: '' }
}

/** Run AI failure analysis on failed script stages (best effort). */
async function annotateFailuresWithAi(
  ctx: RunContext,
  stageResults: StageResult[],
): Promise<void> {
  for (let i = 0; i < stageResults.length; i++) {
    const sr = stageResults[i]
    if (sr.status !== 'failed' || sr.aiAnalysis) continue
    const stage = ctx.stages[i]
    if (!stage || stage.stageType !== 'script') continue
    try {
      const hosts = Object.values(ctx.stageContext.servers ?? {})
        .flat()
        .map((s: ServerInfo) => s.host)
        .join(',')
      const analysis = await analyzeFailure(stage.script ?? '', sr.output ?? '', hosts)
      stageResults[i] = { ...sr, aiAnalysis: analysis }
      // Race-safe: by-name merge under advisory lock (not by-index overwrite),
      // so a concurrent stage_results writer can't lose the aiAnalysis stamp.
      await mergeAiAnalysisIntoStage(ctx.runId, sr.name, analysis).catch(() => {})
    } catch { /* best effort */ }
  }
}

async function finalize(
  ctx: RunContext,
  opts: { fatalError?: string } = {},
): Promise<void> {
  // Tear down Docker container if used. Must run before any async DB ops so
  // cleanup happens even if downstream throws. Ignore teardown failures.
  await ctx.stageContext.dockerExecutor?.teardown().catch((err: unknown) =>
    console.warn('[graph-runner] docker teardown failed:', err),
  )

  const meta = runRegistry.get(ctx.runId)

  let stageResults: StageResult[] = []
  try {
    stageResults = (await getTestRunById(ctx.runId))?.stageResults ?? []
  } catch { /* ignore */ }

  const { status: finalStatus, errorMessage } = summarizeStatus(stageResults, ctx.stages, opts.fatalError)

  if (finalStatus === 'failed') await annotateFailuresWithAi(ctx, stageResults)

  const logDir = meta?.logDir ?? join(DATA_DIR, String(ctx.runId))
  const pipelineName = meta?.pipelineName ?? ctx.stageContext.pipeline?.name ?? ''
  const triggerType = meta?.triggerType ?? 'manual'
  const triggeredBy = meta?.triggeredBy ?? ctx.stageContext.run?.triggeredBy ?? ''
  const serverAssignment = meta?.serverAssignment ?? {}

  try {
    const dtUser = await getDingTalkUserById(triggeredBy).catch(() => null)
    await generateHtmlReport(
      {
        runId: ctx.runId,
        pipelineName,
        triggerType,
        triggeredBy,
        triggeredByName: dtUser?.name,
        triggeredByAvatar: dtUser?.avatar,
        status: finalStatus,
        servers: serverAssignment,
        startedAt: meta?.startedAt?.toISOString() ?? new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        stageResults,
      },
      logDir,
    )
    await generateZipArchive(ctx.runId, logDir)
  } catch (err) {
    console.warn(`[graph-runner] report generation failed for run ${ctx.runId}:`, err)
  }

  await finishTestRun(ctx.runId, finalStatus, logDir, errorMessage).catch((err) => {
    console.error(`[graph-runner] finishTestRun failed for run ${ctx.runId}:`, err)
  })

  const serverIds = meta?.serverIds ?? []
  if (serverIds.length > 0) {
    await bulkSetServerStatus(serverIds, 'idle').catch((err) => {
      console.warn(`[graph-runner] release server locks failed for run ${ctx.runId}:`, err)
    })
  }

  if (meta?.onComplete) {
    try {
      meta.onComplete({
        runId: ctx.runId,
        pipelineName,
        status: finalStatus,
        errorMessage,
        stageResults,
        durationMs: Date.now() - meta.pipelineStartMs,
      })
    } catch { /* swallow */ }
  }

  // Cleanup any lingering interrupt bookkeeping for this run.
  runRegistry.delete(ctx.runId)
  for (const key of Array.from(resolvedInterrupts)) {
    if (key.startsWith(`${ctx.runId}:`)) resolvedInterrupts.delete(key)
  }
  for (const key of Array.from(interruptTimers.keys())) {
    if (key.startsWith(`${ctx.runId}:`)) clearInterruptTimer(key)
  }
}

// --- Read-only inspector (for admin /resume endpoint) ----------------------

/**
 * Read the pending interrupt value for a run without advancing the graph.
 *
 * Used by the admin resume endpoint to validate the caller's body against
 * whatever the graph is actually waiting on (approval vs webhook). Builds
 * the StateGraph via the same path as resumeRun but only calls
 * `compiled.getState(config)` — no stream, no side effects.
 *
 * Returns `null` when:
 *   - the run / pipeline is not found
 *   - the graph has no pending tasks (END, never started, or failed)
 *   - the pending task exists but has no interrupt attached
 *   - the interrupt value isn't one of our known shapes (belt-and-suspenders)
 */
export async function getPendingInterrupt(
  runId: number,
): Promise<ApprovalInterruptValue | WebhookInterruptValue | null> {
  const ctx = await reloadContext(runId)
  if (!ctx) return null
  const saver = await getCheckpointer()
  const graphBuilder = ctx.pipelineGraph
    ? buildGraphFromPipeline({
        graph: ctx.pipelineGraph,
        stageContext: ctx.stageContext,
        hooks: ctx.hooks,
        triggerParams: ctx.triggerParams,
      })
    : buildGraphFromStages({
        stages: ctx.stages,
        stageContext: ctx.stageContext,
        hooks: ctx.hooks,
        triggerParams: ctx.triggerParams,
      })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const compiled = (graphBuilder as any).compile({ checkpointer: saver })
  const config = { configurable: { thread_id: String(runId) } }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const snapshot: any = await compiled.getState(config).catch(() => null)
  if (!snapshot) return null
  // No pending step → graph is at END (or never started).
  const next = snapshot.next as string[] | undefined
  if (!Array.isArray(next) || next.length === 0) return null
  // Walk tasks → first task's first interrupt value. Our graph only ever
  // emits one pending interrupt at a time (single linear stage chain).
  const tasks = snapshot.tasks as Array<{ interrupts?: Array<{ value?: unknown }> }> | undefined
  if (!Array.isArray(tasks) || tasks.length === 0) return null
  for (const task of tasks) {
    const interrupts = task.interrupts
    if (!Array.isArray(interrupts) || interrupts.length === 0) continue
    const value = interrupts[0]?.value
    if (!value || typeof value !== 'object') continue
    const type = (value as { type?: unknown }).type
    if (type === APPROVAL_INTERRUPT) return value as ApprovalInterruptValue
    if (type === WEBHOOK_INTERRUPT) return value as WebhookInterruptValue
    // Unknown interrupt type — ignore defensively rather than leak it.
    return null
  }
  return null
}

// --- Context reload (for resume) -------------------------------------------

async function reloadContext(runId: number): Promise<RunContext | null> {
  const run = await getTestRunById(runId)
  if (!run) return null
  const pipeline = await getTestPipelineById(run.pipelineId)
  if (!pipeline) return null
  const productLine = await getProductLineById(pipeline.productLineId)

  const hasServers = Object.keys(run.servers ?? {}).length > 0
  const allServers = hasServers ? await listTestServers() : []
  const serverMap: Record<string, ServerInfo[]> = {}
  for (const [role, hosts] of Object.entries(run.servers ?? {})) {
    serverMap[role] = (hosts as string[]).map((host) => {
      const srv = allServers.find((s) => s.host === host || s.name === host)
      if (!srv) {
        // Fall back to minimal record; script stages touching this server
        // will fail — the right behaviour after a server was removed.
        return { id: 0, host, port: 22, username: '', password: '', role }
      }
      return {
        id: srv.id,
        host: srv.host,
        port: srv.port,
        username: srv.username,
        password: srv.credential,
        role,
      }
    })
  }

  const logDir = join(DATA_DIR, String(runId))
  const stages = pipeline.stages as StageDefinition[]
  const pipelineGraph = (pipeline.graph as PipelineGraph | null) ?? linearizeStages(stages)
  const hooks = buildDefaultHooks(logDir)

  const stageContext: StageContextBase = {
    runId,
    servers: serverMap,
    logDir,
    productLine: productLine
      ? { name: productLine.name, displayName: productLine.displayName }
      : undefined,
    pipeline: { id: pipeline.id, name: pipeline.name },
    run: { id: runId, triggeredBy: run.triggeredBy, triggerType: run.triggerType },
    variables: { ...(pipeline.variables ?? {}), ...(run.runtimeVars ?? {}) },
    skillExecutor: createProductionSkillExecutor(),
  }

  return {
    runId,
    pipelineId: pipeline.id,
    stages,
    pipelineGraph,
    stageContext,
    hooks,
    // reload triggerParams 合并策略（优先级由低到高）：
    //   1. pipeline.triggerParams（pipeline 模板级默认，seed.sql 定义）
    //   2. run.triggerParams（本次 run 启动时由 worker/coordinator 传入，
    //      如 requirementId / gitlabProject 等业务参数）
    //   3. run.runtimeVars（运行时动态变量，见 coordinator.ts handleAnalysisComplete）
    // 对 approval/capability/skill_with_approval node 的模板展开，所有参数
    // 必须在 resume 时仍可用。
    triggerParams: { ...(pipeline.triggerParams ?? {}), ...(run.triggerParams ?? {}), ...(run.runtimeVars ?? {}) },
  }
}
