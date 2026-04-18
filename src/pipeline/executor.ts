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
import { WebhookWaiter } from './webhook-waiter.js'
import { triggerCapability } from '../agent/coordinator.js'
import { getStageType } from './types.js'
import type { StageDefinition, ServerInfo, StageContext, StageExecutionResult } from './types.js'
import { sshExec } from './ssh.js'
import { writeFile } from 'fs/promises'
import { getDingTalkUserById } from '../db/repositories/dingtalk-users.js'
import type { StageResult } from '../db/repositories/test-runs.js'

const DATA_DIR = process.env.TEST_DATA_DIR || '/data/chatops/test-runs'

async function executeApprovalStage(stage: StageDefinition, triggerParams?: Record<string, unknown>): Promise<StageExecutionResult> {
  const approverIds = stage.approverIds ?? []
  if (approverIds.length === 0) return { status: 'failed', output: '未配置审批人', error: 'no approvers' }

  // 构建审批描述，包含 Issue 信息
  const issueId = triggerParams?.issueId
  const gitlabUrl = process.env.GITLAB_URL ?? ''
  let description = stage.approvalDescription ?? stage.name
  if (issueId) {
    // 查询分析报告获取详情
    try {
      const { getBugAnalysisReportByIssueId } = await import('../db/repositories/bug-analysis-reports.js')
      const { getByProductLineId } = await import('../db/repositories/product-knowledge-repos.js')
      const report = await getBugAnalysisReportByIssueId(Number(issueId))
      if (report) {
        const knowledgeRepo = await getByProductLineId(report.productLineId)
        const projectPath = knowledgeRepo ? knowledgeRepo.codeRepoUrl.replace(/\.git$/, '').replace(/https?:\/\/[^/]+\//, '') : ''
        const issueUrl = `${gitlabUrl}/${projectPath}/-/issues/${issueId}`
        const solutionsSummary = report.solutionsJson
          ?.map((s: any) => `- ${s.recommended ? '⭐' : '•'} ${s.summary}（风险:${s.risk}）`)
          .join('\n') ?? ''
        description = `${description}\n\nIssue: ${issueUrl}\n等级: ${report.level}\n根因: ${report.rootCauseSummary}\n\n修复方案:\n${solutionsSummary}`
      }
    } catch {}
  }

  const timeoutMs = (stage.timeoutSeconds ?? 3600) * 1000
  try {
    const mgr = PipelineApprovalManager.getInstance()
    const decision = await mgr.requestApproval(approverIds, description, timeoutMs, issueId ? String(issueId) : undefined)
    if (decision === 'approved') return { status: 'success', output: '审批通过' }
    if (decision === 'timeout') return { status: 'failed', output: '审批超时', error: 'timeout' }
    return { status: 'failed', output: '审批被拒绝', error: 'rejected' }
  } catch (err) {
    return { status: 'failed', output: `审批流程错误: ${String(err)}`, error: String(err) }
  }
}

/** 解析 capabilityParams 中的模板变量 {{triggerParams.xxx}} */
function resolveCapabilityParams(
  params: Record<string, unknown> | undefined,
  triggerParams: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!params) return params
  const resolved: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string') {
      const match = value.match(/^\{\{triggerParams\.(\w+)\}\}$/)
      if (match && triggerParams) {
        resolved[key] = triggerParams[match[1]]
      } else {
        resolved[key] = value
      }
    } else {
      resolved[key] = value
    }
  }
  return resolved
}

async function executeCapabilityStage(stage: StageDefinition, ctx: StageContext, triggerParams?: Record<string, unknown>): Promise<StageExecutionResult> {
  const capabilityKey = stage.capabilityKey
  if (!capabilityKey) return { status: 'failed', output: '未配置 capabilityKey', error: 'no capabilityKey' }

  const timeoutMs = (stage.timeoutSeconds ?? 1200) * 1000
  const resolvedParams = resolveCapabilityParams(stage.capabilityParams, triggerParams)
  console.log(`[Pipeline] capability stage: ${capabilityKey} (timeout ${timeoutMs}ms)`)

  const abortController = new AbortController()

  try {
    const capabilityPromise = triggerCapability({
      capabilityKey,
      context: {
        taskId: `pipeline-${ctx.runId}-stage-${ctx.stageIndex}`,
        groupId: 'pipeline',
        platform: 'pipeline',
        initiatorId: 'pipeline-executor',
        initiatorRole: 'admin',
      },
      extraParams: resolvedParams,
      signal: abortController.signal,
    })

    const timeoutPromise = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        abortController.abort()
        reject(new Error('capability 执行超时'))
      }, timeoutMs)
      // 如果 capability 先完成，清除 timer
      capabilityPromise.finally(() => clearTimeout(timer))
    })

    const result = await Promise.race([capabilityPromise, timeoutPromise])

    return {
      status: result.success ? 'success' : 'failed',
      output: result.output ?? '',
      error: result.error,
    }
  } catch (err) {
    abortController.abort()
    return { status: 'failed', output: `capability 执行失败: ${String(err)}`, error: String(err) }
  }
}

async function executeWaitWebhookStage(
  stage: StageDefinition,
  runId: number,
  stageIndex: number,
  stageResults: StageResult[]
): Promise<StageExecutionResult> {
  const webhookTag = stage.webhookTag
  if (!webhookTag) return { status: 'failed', output: '未配置 webhookTag', error: 'no webhookTag' }

  const timeoutMs = (stage.timeoutSeconds ?? 3600) * 1000
  console.log(`[Pipeline] wait_webhook stage: ${webhookTag} (timeout ${timeoutMs}ms)`)

  // 标记为 waiting 状态
  stageResults[stageIndex] = { ...stageResults[stageIndex], status: 'waiting' }
  await updateTestRunStage(runId, stageIndex, stageResults)

  const waiter = WebhookWaiter.getInstance()
  const result = await waiter.wait(webhookTag, timeoutMs)

  if (result) {
    return { status: 'success', output: `webhook 已到达: ${webhookTag}` }
  }
  return { status: 'failed', output: `等待 webhook 超时: ${webhookTag}`, error: 'timeout' }
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
  onComplete?: (result: PipelineRunResult) => void,
  triggerParams?: Record<string, unknown>
): Promise<number> {
  const pipelineStartTime = Date.now()
  const pipeline = await getTestPipelineById(pipelineId)
  if (!pipeline) throw new Error(`Pipeline ${pipelineId} not found`)

  const productLine = await getProductLineById(pipeline.productLineId)

  // Create run record
  const run = await createTestRun({ pipelineId, triggerType, triggeredBy, servers: serverAssignment })
  const logDir = join(DATA_DIR, String(run.id))
  await mkdir(logDir, { recursive: true })

  // Resolve server info from DB (skip for serverless pipelines)
  const hasServers = Object.keys(serverAssignment).length > 0
  const allServers = hasServers ? await listTestServers(pipeline.productLineId) : []
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

  // Lock servers (skip for serverless pipelines)
  if (serverIds.length > 0) await bulkSetServerStatus(serverIds, 'in_use')

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

        const result = await executeApprovalStage(stage, triggerParams)
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

      // Capability stages — trigger Agent capability
      if (getStageType(stage) === 'capability') {
        const startTime = Date.now()
        stageResults[i] = { ...stageResults[i], status: 'running', startedAt: new Date().toISOString() }
        await updateTestRunStage(run.id, i, stageResults)

        const ctx: StageContext = {
          runId: run.id, stageIndex: i, servers: serverMap, logDir,
          productLine: productLine ? { name: productLine.name, displayName: productLine.displayName } : undefined,
          pipeline: { id: pipeline.id, name: pipeline.name },
          run: { id: run.id, triggeredBy, triggerType },
          variables: pipeline.variables ?? {},
        }

        const result = await executeCapabilityStage(stage, ctx, triggerParams)
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

      // Wait webhook stages — pause until external event
      if (getStageType(stage) === 'wait_webhook') {
        const startTime = Date.now()
        stageResults[i] = { ...stageResults[i], status: 'waiting', startedAt: new Date().toISOString() }
        await updateTestRunStage(run.id, i, stageResults)

        const result = await executeWaitWebhookStage(stage, run.id, i, stageResults)
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
          variables: pipeline.variables ?? {},
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
    if (serverIds.length > 0) await bulkSetServerStatus(serverIds, 'idle')
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
