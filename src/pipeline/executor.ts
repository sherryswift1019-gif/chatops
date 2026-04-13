import { mkdir } from 'fs/promises'
import { join } from 'path'
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
import type { StageResult } from '../db/repositories/test-runs.js'

const DATA_DIR = process.env.TEST_DATA_DIR || '/data/chatops/test-runs'

async function executeStage(stage: StageDefinition, servers: ServerInfo[], ctx: StageContext): Promise<StageExecutionResult> {
  const params = stage.params as unknown
  switch (stage.type) {
    case 'cleanup': return executeCleanup(params as CleanupParams, servers, ctx)
    case 'download': return executeDownload(params as DownloadParams, servers, ctx)
    case 'install': return executeInstall(params as InstallParams, servers, ctx)
    case 'health_check': return executeHealthCheck(params as HealthCheckParams, servers, ctx)
    case 'test': return executeTest(params as TestParams, servers, ctx)
    case 'custom': return executeCustom(params as CustomParams, servers, ctx)
    case 'report': return { status: 'success', output: 'Report generated at pipeline completion' }
    default: return { status: 'failed', output: `Unknown stage type: ${stage.type}`, error: 'unsupported' }
  }
}

export async function runPipeline(pipelineId: number, serverAssignment: Record<string, string[]>, triggerType: 'manual' | 'api' | 'scheduled', triggeredBy: string): Promise<number> {
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
  const stageResults: StageResult[] = stages.map(s => ({ name: s.name, type: s.type, status: 'pending' as const }))

  let finalStatus: 'success' | 'failed' = 'success'
  let errorMessage = ''

  try {
    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i]
      if (stage.type === 'report') continue // Report is generated at the end

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

  return run.id
}
