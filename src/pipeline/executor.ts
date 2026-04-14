import { mkdir } from 'fs/promises'
import { join, dirname } from 'path'
import { getTestPipelineById } from '../db/repositories/test-pipelines.js'
import { createTestRun, updateTestRunStage, finishTestRun } from '../db/repositories/test-runs.js'
import { listTestServers, bulkSetServerStatus } from '../db/repositories/test-servers.js'
import { generateHtmlReport, generateZipArchive } from './report-generator.js'
import { executeCleanup } from './stages/cleanup.js'
import { executeDownload } from './stages/download.js'
import { executeInstall } from './stages/install.js'
import { executeHealthCheck } from './stages/health-check.js'
import { executeTest } from './stages/test.js'
import { executeCustom } from './stages/custom.js'
import type { StageDefinition, ServerInfo, StageContext, StageExecutionResult, CleanupParams, DownloadParams, InstallParams, HealthCheckParams, TestParams, CustomParams } from './types.js'
import { getStageOperationKey } from './types.js'
import { sshExecWithLog, sshExec } from './ssh.js'
import { writeFile } from 'fs/promises'
import type { StageResult } from '../db/repositories/test-runs.js'

// Execute new-format stages with { commands?, script? } params
// Captures stdout/stderr both to log file and to output for UI display
async function executeNewShellStage(params: Record<string, unknown>, servers: ServerInfo[], ctx: StageContext, label: string): Promise<StageExecutionResult> {
  const logFile = join(ctx.logDir, `${String(ctx.stageIndex + 1).padStart(2, '0')}-${label}.log`)
  const commands = (params.commands as string)?.trim() ?? ''
  const script = (params.script as string)?.trim() ?? ''
  const cmd = [commands, script].filter(Boolean).join('\n')
  if (!cmd) return { status: 'success', output: 'No commands to execute' }

  const allLogs: string[] = []
  let failed = false
  let failError = ''

  for (const server of servers) {
    const sshCfg = { host: server.host, port: server.port, username: server.username, password: server.password }
    allLogs.push(`=== ${server.host} ===`)
    try {
      const result = await sshExec(sshCfg, cmd)
      if (result.stdout) allLogs.push(`[stdout]\n${result.stdout.trimEnd()}`)
      if (result.stderr) allLogs.push(`[stderr]\n${result.stderr.trimEnd()}`)
      allLogs.push(`[exit code] ${result.code}`)
      if (result.code !== 0) {
        failed = true
        failError = `exit code ${result.code} on ${server.host}`
      }
    } catch (err) {
      allLogs.push(`[error] ${String(err)}`)
      failed = true
      failError = String(err)
    }
  }

  // Write full log to file
  await mkdir(dirname(logFile), { recursive: true }).catch(() => {})
  await writeFile(logFile, allLogs.join('\n') + '\n').catch(() => {})

  const output = allLogs.join('\n')
  if (failed) return { status: 'failed', output, error: failError }
  return { status: 'success', output }
}

const DATA_DIR = process.env.TEST_DATA_DIR || '/data/chatops/test-runs'

async function executeStage(stage: StageDefinition, servers: ServerInfo[], ctx: StageContext): Promise<StageExecutionResult> {
  const params = stage.params as unknown
  const capKey = getStageOperationKey(stage)
  // Map capabilityKey to executor (supports both new capabilityKey and legacy type)
  const EXECUTOR_MAP: Record<string, () => Promise<StageExecutionResult>> = {
    env_cleanup: () => executeNewShellStage(params as Record<string, unknown>, servers, ctx, 'cleanup'),
    env_init: () => executeNewShellStage(params as Record<string, unknown>, servers, ctx, 'init'),
    deploy: () => {
      const p = params as Record<string, unknown>
      if (p.deployType === 'container') return executeNewShellStage(p, servers, ctx, 'deploy')
      if (p.packageUrl) {
        return executeDownload({ sourceUrl: p.packageUrl as string, destPath: p.downloadDir as string ?? '/tmp', checksum: p.checksum as string, extract: p.extract as boolean ?? true } as DownloadParams, servers, ctx)
      }
      return executeNewShellStage(p, servers, ctx, 'deploy')
    },
    health_check: () => executeHealthCheck(params as HealthCheckParams, servers, ctx),
    auto_test: () => executeTest(params as TestParams, servers, ctx),
    custom_script: () => executeNewShellStage(params as Record<string, unknown>, servers, ctx, 'custom'),
    report_gen: () => Promise.resolve({ status: 'success' as const, output: 'Report generated at pipeline completion' }),
    log_collect: () => executeNewShellStage(params as Record<string, unknown>, servers, ctx, 'log-collect'),
    rollback: () => executeNewShellStage(params as Record<string, unknown>, servers, ctx, 'rollback'),
    restart: () => executeNewShellStage(params as Record<string, unknown>, servers, ctx, 'restart'),
    // Legacy type mappings
    cleanup: () => executeCleanup(params as CleanupParams, servers, ctx),
    download: () => executeDownload(params as DownloadParams, servers, ctx),
    install: () => executeInstall(params as InstallParams, servers, ctx),
    test: () => executeTest(params as TestParams, servers, ctx),
    custom: () => executeCustom(params as CustomParams, servers, ctx),
    report: () => Promise.resolve({ status: 'success' as const, output: 'Report generated at pipeline completion' }),
  }
  const executor = EXECUTOR_MAP[capKey]
  if (executor) return executor()
  return { status: 'failed', output: `Unknown capability: ${capKey}`, error: 'unsupported' }
}

export interface PipelineRunResult {
  runId: number
  pipelineName: string
  status: 'success' | 'failed'
  errorMessage: string
  stageResults: StageResult[]
  durationMs: number
}

export async function runPipeline(
  pipelineId: number,
  serverAssignment: Record<string, string[]>,
  triggerType: 'manual' | 'api' | 'scheduled',
  triggeredBy: string,
  onComplete?: (result: PipelineRunResult) => void
): Promise<number> {
  const pipelineStartTime = Date.now()
  const pipeline = await getTestPipelineById(pipelineId)
  if (!pipeline) throw new Error(`Pipeline ${pipelineId} not found`)

  // Create run record
  const run = await createTestRun({ pipelineId, triggerType, triggeredBy, servers: serverAssignment })
  const logDir = join(DATA_DIR, String(run.id))
  await mkdir(logDir, { recursive: true })

  // Resolve server info from DB
  const allServers = await listTestServers(pipeline.productLineId)
  const serverMap: Record<string, ServerInfo[]> = {}
  const serverIds: number[] = []

  for (const [role, hosts] of Object.entries(serverAssignment)) {
    serverMap[role] = hosts.map(host => {
      const srv = allServers.find(s => s.host === host || s.name === host)
      if (!srv) throw new Error(`Server "${host}" not found in product line`)
      serverIds.push(srv.id)
      return { id: srv.id, host: srv.host, port: srv.port, username: srv.username, password: srv.credential, role }
    })
  }

  // Lock servers
  await bulkSetServerStatus(serverIds, 'in_use')

  const stages = pipeline.stages as StageDefinition[]
  const stageResults: StageResult[] = stages.map(s => ({ name: s.name, type: getStageOperationKey(s), status: 'pending' as const }))

  let finalStatus: 'success' | 'failed' = 'success'
  let errorMessage = ''

  try {
    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i]
      const capKey = getStageOperationKey(stage)
      if (capKey === 'report' || capKey === 'report_gen') continue // Report is generated at the end

      // Determine target servers
      const targetServers = stage.targetRoles.length > 0
        ? stage.targetRoles.flatMap(role => serverMap[role] ?? [])
        : Object.values(serverMap).flat()

      if (targetServers.length === 0) {
        stageResults[i] = { ...stageResults[i], status: 'skipped', output: 'No servers for target roles' }
        await updateTestRunStage(run.id, i, stageResults)
        continue
      }

      // Update stage to running
      const startTime = Date.now()
      stageResults[i] = { ...stageResults[i], status: 'running', startedAt: new Date().toISOString() }
      await updateTestRunStage(run.id, i, stageResults)

      // Execute with retry
      let result: StageExecutionResult = { status: 'failed', output: 'Not executed' }
      for (let attempt = 0; attempt <= stage.retryCount; attempt++) {
        const ctx: StageContext = { runId: run.id, stageIndex: i, servers: serverMap, logDir }

        if (stage.parallel && targetServers.length > 1) {
          // Parallel execution on all target servers simultaneously
          const promises = targetServers.map(server => executeStage(stage, [server], ctx))
          const results = await Promise.all(promises)
          const failed = results.find(r => r.status === 'failed')
          result = failed ?? { status: 'success', output: results.map(r => r.output).join('\n'), artifacts: results.flatMap(r => r.artifacts ?? []) }
        } else {
          result = await executeStage(stage, targetServers, ctx)
        }

        if (result.status === 'success') break
        if (attempt < stage.retryCount) {
          stageResults[i] = { ...stageResults[i], output: `Retry ${attempt + 1}/${stage.retryCount}...` }
          await updateTestRunStage(run.id, i, stageResults)
        }
      }

      const durationMs = Date.now() - startTime
      stageResults[i] = {
        ...stageResults[i],
        status: result.status,
        finishedAt: new Date().toISOString(),
        durationMs,
        output: result.output,
        error: result.error,
      }
      await updateTestRunStage(run.id, i, stageResults)

      if (result.status === 'failed') {
        if (stage.onFailure === 'stop') {
          finalStatus = 'failed'
          errorMessage = `Stage "${stage.name}" failed: ${result.error ?? result.output}`
          // Mark remaining stages as skipped
          for (let j = i + 1; j < stages.length; j++) {
            stageResults[j] = { ...stageResults[j], status: 'skipped' }
          }
          await updateTestRunStage(run.id, i, stageResults)
          break
        }
        finalStatus = 'failed'
        errorMessage = `Stage "${stage.name}" failed but continued`
      }
    }

    // Generate report
    const reportData = {
      runId: run.id,
      pipelineName: pipeline.name,
      triggerType,
      triggeredBy,
      status: finalStatus,
      servers: serverAssignment,
      startedAt: run.startedAt?.toISOString() ?? new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      stageResults,
    }
    await generateHtmlReport(reportData, logDir)
    await generateZipArchive(run.id, logDir)

    await finishTestRun(run.id, finalStatus, logDir, errorMessage)
  } catch (err) {
    await finishTestRun(run.id, 'failed', logDir, String(err))
    finalStatus = 'failed'
  } finally {
    // Release servers
    await bulkSetServerStatus(serverIds, 'idle')
  }

  if (onComplete) {
    try {
      onComplete({
        runId: run.id,
        pipelineName: pipeline.name,
        status: finalStatus,
        errorMessage,
        stageResults,
        durationMs: Date.now() - pipelineStartTime,
      })
    } catch { /* callback errors should not affect run result */ }
  }

  return run.id
}
