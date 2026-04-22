/**
 * executor — pipeline run entry point. Delegates execution to the LangGraph
 * graph-runner (compile + stream + interrupt dispatch). Keeps the legacy
 * for-loop executor reachable via PIPELINE_ENGINE=legacy for rollback.
 *
 * Responsibilities retained here:
 *   - Resolve artifact inputs up front (so we can 400 the caller on failure)
 *   - Create the test_runs row, resolve servers, lock servers in_use
 *   - Build the StageHooks + StageContextBase that the graph needs
 *   - Register the finalize meta (logDir, onComplete, serverIds, ...) with
 *     graph-runner so the runtime can complete the run after any number of
 *     interrupt/resume cycles
 *   - Hand control to graph-runner.startRun
 *
 * Everything below — stage-by-stage execution, retry loop, AI failure
 * analysis, HTML report, finishTestRun, server lock release, onComplete —
 * now happens inside graph-runner.
 */

import { mkdir } from 'fs/promises'
import { join } from 'path'
import { getTestPipelineById } from '../db/repositories/test-pipelines.js'
import { createTestRun, finishTestRun } from '../db/repositories/test-runs.js'
import { listTestServers, bulkSetServerStatus } from '../db/repositories/test-servers.js'
import { getProductLineById } from '../db/repositories/product-lines.js'
import { resolveArtifact } from './artifact-resolver.js'
import { buildDefaultHooks } from './executor-hooks.js'
import {
  startRun,
  registerRunMeta,
  purgeRunMeta,
  type FinalizeMeta,
  type PipelineRunResult,
} from './graph-runner.js'
import { linearizeStages } from './graph-migration.js'
import type { StageContextBase } from './graph-builder.js'
import type { StageDefinition, ServerInfo, ArtifactInput, PipelineGraph } from './types.js'

const DATA_DIR = process.env.TEST_DATA_DIR || '/data/chatops/test-runs'

export type { PipelineRunResult } from './graph-runner.js'

export interface ImTriggerContext {
  platform: string
  groupId: string
  userId: string
}

/**
 * Kick off a pipeline run. Returns the run id as soon as the initial invoke
 * has either completed or hit its first interrupt. The run continues
 * asynchronously after interrupts via IM callbacks / webhooks / timeouts —
 * those all route back through graph-runner.resumeRun.
 */
export async function runPipeline(
  pipelineId: number,
  serverAssignment: Record<string, string[]>,
  triggerType: 'manual' | 'api' | 'scheduled' | 'im',
  triggeredBy: string,
  runtimeVarsInput: Record<string, string> = {},
  onComplete?: (result: PipelineRunResult) => void,
  triggerParams?: Record<string, unknown>,
  imContext?: ImTriggerContext,
): Promise<number> {
  // Legacy fallback for rollback scenarios.
  if (process.env.PIPELINE_ENGINE === 'legacy') {
    const { runPipeline: legacy } = await import('./executor-legacy.js')
    return legacy(
      pipelineId,
      serverAssignment,
      triggerType,
      triggeredBy,
      runtimeVarsInput,
      onComplete,
      triggerParams,
    )
  }

  const pipelineStartMs = Date.now()
  const pipeline = await getTestPipelineById(pipelineId)
  if (!pipeline) throw new Error(`Pipeline ${pipelineId} not found`)

  const productLine = await getProductLineById(pipeline.productLineId)

  // Resolve artifact inputs (interactive callers want fast-fail; scheduled
  // runs record a failed run for audit).
  const artifactInputs = (pipeline.artifactInputs ?? []) as ArtifactInput[]
  const runtimeVars: Record<string, string> = { ...runtimeVarsInput }
  let resolveError: Error | null = null
  try {
    for (const input of artifactInputs) {
      const provided = runtimeVars[input.outputVar]
      runtimeVars[input.outputVar] = await resolveArtifact(input, provided)
    }
  } catch (e) {
    resolveError = e as Error
  }

  if (resolveError && triggerType !== 'scheduled') {
    throw new Error(`制品输入解析失败: ${resolveError.message}`)
  }

  const run = await createTestRun({
    pipelineId,
    triggerType,
    triggeredBy,
    servers: serverAssignment,
    runtimeVars: resolveError ? runtimeVarsInput : runtimeVars,
  })

  // Record a failed run and bail if we couldn't even resolve the inputs.
  if (resolveError) {
    await finishTestRun(run.id, 'failed', '', `制品输入解析失败: ${resolveError.message}`)
    return run.id
  }

  const logDir = join(DATA_DIR, String(run.id))
  await mkdir(logDir, { recursive: true })

  // Resolve server info from DB (serverless pipelines skip this entirely).
  const hasServers = Object.keys(serverAssignment).length > 0
  const allServers = hasServers ? await listTestServers(pipeline.productLineId) : []
  const serverMap: Record<string, ServerInfo[]> = {}
  const serverIds: number[] = []

  for (const [role, hosts] of Object.entries(serverAssignment)) {
    serverMap[role] = hosts.map((host) => {
      const srv = allServers.find((s) => s.host === host || s.name === host)
      if (!srv) throw new Error(`Server "${host}" not found in product line`)
      serverIds.push(srv.id)
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

  if (serverIds.length > 0) await bulkSetServerStatus(serverIds, 'in_use')

  const stages = pipeline.stages as StageDefinition[]
  const pipelineGraph: PipelineGraph = (pipeline.graph as PipelineGraph | null) ?? linearizeStages(stages)

  const stageContext: StageContextBase = {
    runId: run.id,
    servers: serverMap,
    logDir,
    productLine: productLine
      ? { name: productLine.name, displayName: productLine.displayName }
      : undefined,
    pipeline: { id: pipeline.id, name: pipeline.name },
    run: { id: run.id, triggeredBy, triggerType },
    variables: { ...(pipeline.variables ?? {}), ...runtimeVars },
    triggerPlatform: imContext?.platform,
    triggerGroupId: imContext?.groupId,
    triggerUserId: imContext?.userId,
  }

  const hooks = buildDefaultHooks(logDir)

  const meta: FinalizeMeta = {
    runId: run.id,
    pipelineId: pipeline.id,
    pipelineName: pipeline.name,
    triggerType,
    triggeredBy,
    serverAssignment,
    serverIds,
    logDir,
    startedAt: run.startedAt,
    pipelineStartMs,
    onComplete,
  }
  registerRunMeta(meta)

  // Fire and forget — startRun resolves after the graph hits END or its first
  // interrupt. Subsequent interrupts/timeouts resume via graph-runner.resumeRun.
  startRun({
    runId: run.id,
    pipelineId: pipeline.id,
    stages,
    pipelineGraph,
    stageContext,
    hooks,
    triggerParams,
  }).catch(async (err) => {
    console.error(`[executor] startRun failed for run ${run.id}:`, err)
    // streamGraph's main try/catch routes fatal errors through finalize() which
    // clears runRegistry itself. But if it throws *before* entering that try
    // (e.g. getCheckpointer() or compile() throws synchronously), finalize is
    // never called and the registry entry would leak — so purge it here.
    purgeRunMeta(run.id)
    await finishTestRun(run.id, 'failed', logDir, String(err)).catch(() => {})
    if (serverIds.length > 0) {
      await bulkSetServerStatus(serverIds, 'idle').catch(() => {})
    }
  })

  return run.id
}
