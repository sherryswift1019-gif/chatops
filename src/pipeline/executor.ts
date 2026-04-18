import { mkdir } from 'fs/promises'
import { join, dirname } from 'path'
import { getTestPipelineById } from '../db/repositories/test-pipelines.js'
import { createTestRun, updateTestRunStage, finishTestRun } from '../db/repositories/test-runs.js'
import { listTestServers, bulkSetServerStatus } from '../db/repositories/test-servers.js'
import { getProductLineById } from '../db/repositories/product-lines.js'
import { generateHtmlReport, generateZipArchive } from './report-generator.js'
import { resolveVariables, type VariableContext } from './variables.js'
import { analyzeFailure } from './failure-analyzer.js'
import { PipelineApprovalManager } from './approval-manager.js'
import { getStageType } from './types.js'
import type { StageDefinition, ServerInfo, StageContext, StageExecutionResult, ArtifactInput } from './types.js'
import { resolveArtifact } from './artifact-resolver.js'
import { sshExec } from './ssh.js'
import { writeFile } from 'fs/promises'
import { getDingTalkUserById } from '../db/repositories/dingtalk-users.js'
import type { StageResult } from '../db/repositories/test-runs.js'

const DATA_DIR = process.env.TEST_DATA_DIR || '/data/chatops/test-runs'

async function executeApprovalStage(stage: StageDefinition): Promise<StageExecutionResult> {
  const approverIds = stage.approverIds ?? []
  if (approverIds.length === 0) return { status: 'failed', output: '未配置审批人', error: 'no approvers' }
  const description = stage.approvalDescription ?? stage.name
  const timeoutMs = (stage.timeoutSeconds ?? 3600) * 1000
  try {
    const mgr = PipelineApprovalManager.getInstance()
    const decision = await mgr.requestApproval(approverIds, description, timeoutMs)
    if (decision === 'approved') return { status: 'success', output: '审批通过' }
    if (decision === 'timeout') return { status: 'failed', output: '审批超时', error: 'timeout' }
    return { status: 'failed', output: '审批被拒绝', error: 'rejected' }
  } catch (err) {
    return { status: 'failed', output: `审批流程错误: ${String(err)}`, error: String(err) }
  }
}

async function executeStage(stage: StageDefinition, servers: ServerInfo[], ctx: StageContext): Promise<StageExecutionResult> {
  if (getStageType(stage) === 'approval') {
    return executeApprovalStage(stage)
  }

  // script stage — resolve variables per server, then execute via SSH
  const script = stage.script ?? ''
  if (!script.trim()) return { status: 'success', output: 'No script to execute' }

  const logFile = join(ctx.logDir, `${String(ctx.stageIndex + 1).padStart(2, '0')}-script.log`)
  const allLogs: string[] = []
  let failed = false
  let failError = ''

  for (const server of servers) {
    const varCtx: VariableContext = {
      productLine: ctx.productLine ?? { name: '', displayName: '' },
      pipeline: ctx.pipeline ?? { id: 0, name: '' },
      run: ctx.run ?? { id: ctx.runId, triggeredBy: '', triggerType: '' },
      stage: { name: stage.name, index: ctx.stageIndex },
      server: { host: server.host, port: server.port, username: server.username, name: '', role: server.role },
      vars: ctx.variables ?? {},
    }
    const resolved = resolveVariables(script, varCtx)
    const sshCfg = { host: server.host, port: server.port, username: server.username, password: server.password }
    allLogs.push(`=== ${server.host} ===`)
    try {
      const result = await sshExec(sshCfg, resolved)
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

  await mkdir(dirname(logFile), { recursive: true }).catch(() => {})
  await writeFile(logFile, allLogs.join('\n') + '\n').catch(() => {})

  const output = allLogs.join('\n')
  if (failed) return { status: 'failed', output, error: failError }
  return { status: 'success', output }
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
  runtimeVarsInput: Record<string, string> = {},
  onComplete?: (result: PipelineRunResult) => void
): Promise<number> {
  const pipelineStartTime = Date.now()
  const pipeline = await getTestPipelineById(pipelineId)
  if (!pipeline) throw new Error(`Pipeline ${pipelineId} not found`)

  const productLine = await getProductLineById(pipeline.productLineId)

  // Resolve artifact inputs; any failure should still be recorded as a failed run
  const artifactInputs = (pipeline.artifactInputs ?? []) as ArtifactInput[]
  const runtimeVars: Record<string, string> = { ...runtimeVarsInput }
  let resolveError: Error | null = null
  try {
    for (const input of artifactInputs) {
      const provided = runtimeVars[input.outputVar]
      const value = await resolveArtifact(input, provided)
      runtimeVars[input.outputVar] = value
    }
  } catch (e) {
    resolveError = e as Error
  }

  // Create run record (persist the caller's original input on failure,
  // full resolved vars on success — both are useful for audit)
  const run = await createTestRun({
    pipelineId, triggerType, triggeredBy,
    servers: serverAssignment,
    runtimeVars: resolveError ? runtimeVarsInput : runtimeVars,
  })

  if (resolveError) {
    await finishTestRun(run.id, 'failed', '', `制品输入解析失败: ${resolveError.message}`)
    return run.id
  }

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
  const stageResults: StageResult[] = stages.map(s => ({ name: s.name, type: getStageType(s), status: 'pending' as const }))

  let finalStatus: 'success' | 'failed' = 'success'
  let errorMessage = ''

  try {
    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i]

      // Approval stages don't need target servers
      if (getStageType(stage) === 'approval') {
        const startTime = Date.now()
        stageResults[i] = { ...stageResults[i], status: 'running', startedAt: new Date().toISOString() }
        await updateTestRunStage(run.id, i, stageResults)

        const result = await executeApprovalStage(stage)
        stageResults[i] = {
          ...stageResults[i], status: result.status, finishedAt: new Date().toISOString(),
          durationMs: Date.now() - startTime, output: result.output, error: result.error,
        }
        await updateTestRunStage(run.id, i, stageResults)

        if (result.status === 'failed') {
          if (stage.onFailure === 'stop') {
            finalStatus = 'failed'
            errorMessage = `Stage "${stage.name}" failed: ${result.error ?? result.output}`
            for (let j = i + 1; j < stages.length; j++) stageResults[j] = { ...stageResults[j], status: 'skipped' }
            await updateTestRunStage(run.id, i, stageResults)
            break
          }
          finalStatus = 'failed'
          errorMessage = `Stage "${stage.name}" failed but continued`
        }
        continue
      }

      // Script stages need target servers
      const targetServers = stage.targetRoles.length > 0
        ? stage.targetRoles.flatMap(role => serverMap[role] ?? [])
        : Object.values(serverMap).flat()

      if (targetServers.length === 0) {
        stageResults[i] = { ...stageResults[i], status: 'skipped', output: 'No servers for target roles' }
        await updateTestRunStage(run.id, i, stageResults)
        continue
      }

      const startTime = Date.now()
      stageResults[i] = { ...stageResults[i], status: 'running', startedAt: new Date().toISOString() }
      await updateTestRunStage(run.id, i, stageResults)

      // Execute with retry
      let result: StageExecutionResult = { status: 'failed', output: 'Not executed' }
      for (let attempt = 0; attempt <= stage.retryCount; attempt++) {
        const ctx: StageContext = {
          runId: run.id, stageIndex: i, servers: serverMap, logDir,
          productLine: productLine ? { name: productLine.name, displayName: productLine.displayName } : undefined,
          pipeline: { id: pipeline.id, name: pipeline.name },
          run: { id: run.id, triggeredBy, triggerType },
          variables: { ...(pipeline.variables ?? {}), ...runtimeVars },
        }

        if (stage.parallel && targetServers.length > 1) {
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
        ...stageResults[i], status: result.status, finishedAt: new Date().toISOString(),
        durationMs, output: result.output, error: result.error,
      }
      await updateTestRunStage(run.id, i, stageResults)

      // AI failure analysis for script stages
      if (result.status === 'failed') {
        try {
          const analysis = await analyzeFailure(stage.script ?? '', result.output ?? '', targetServers.map(s => s.host).join(','))
          stageResults[i] = { ...stageResults[i], aiAnalysis: analysis }
          await updateTestRunStage(run.id, i, stageResults)
        } catch { /* AI analysis is best-effort */ }

        if (stage.onFailure === 'stop') {
          finalStatus = 'failed'
          errorMessage = `Stage "${stage.name}" failed: ${result.error ?? result.output}`
          for (let j = i + 1; j < stages.length; j++) stageResults[j] = { ...stageResults[j], status: 'skipped' }
          await updateTestRunStage(run.id, i, stageResults)
          break
        }
        finalStatus = 'failed'
        errorMessage = `Stage "${stage.name}" failed but continued`
      }
    }

    // Resolve triggeredBy user info
    const dtUser = await getDingTalkUserById(triggeredBy).catch(() => null)

    // Generate report
    const reportData = {
      runId: run.id,
      pipelineName: pipeline.name,
      triggerType,
      triggeredBy,
      triggeredByName: dtUser?.name,
      triggeredByAvatar: dtUser?.avatar,
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
    await bulkSetServerStatus(serverIds, 'idle')
  }

  if (onComplete) {
    try {
      onComplete({
        runId: run.id, pipelineName: pipeline.name, status: finalStatus,
        errorMessage, stageResults, durationMs: Date.now() - pipelineStartTime,
      })
    } catch { /* callback errors should not affect run result */ }
  }

  return run.id
}
