import { getCapabilityByKey } from '../db/repositories/capabilities.js'
import { findOwner } from '../db/repositories/module-owners.js'
import { getBugAnalysisReportByIssueId } from '../db/repositories/bug-analysis-reports.js'
import { getTestPipelineByName } from '../db/repositories/test-pipelines.js'
import { runPipeline } from '../pipeline/executor.js'
import type { TaskContext } from './tools/types.js'
import type { ApprovalGate } from '../approval/gate.js'

export interface TriggerOptions {
  capabilityKey: string
  context: TaskContext
  extraParams?: Record<string, unknown>
  signal?: AbortSignal
}

export interface TriggerResult {
  success: boolean
  output?: string
  error?: string
  data?: unknown
}

type CapabilityHandler = (opts: TriggerOptions) => Promise<TriggerResult>

const handlers = new Map<string, CapabilityHandler>()

let approvalGate: ApprovalGate | null = null
export function setApprovalGate(gate: ApprovalGate): void { approvalGate = gate }

export function registerCapabilityHandler(capabilityKey: string, handler: CapabilityHandler): void {
  handlers.set(capabilityKey, handler)
  console.log(`[AgentCoordinator] registered handler: ${capabilityKey}`)
}

export async function triggerCapability(opts: TriggerOptions): Promise<TriggerResult> {
  console.log(`[AgentCoordinator] triggering: ${opts.capabilityKey}`, {
    taskId: opts.context.taskId,
    groupId: opts.context.groupId,
  })

  const capability = await getCapabilityByKey(opts.capabilityKey)
  if (!capability) {
    const msg = `capability not found: ${opts.capabilityKey}`
    console.error(`[AgentCoordinator] ${msg}`)
    return { success: false, error: msg }
  }

  const handler = handlers.get(opts.capabilityKey)
  if (!handler) {
    const msg = `no handler registered for: ${opts.capabilityKey}`
    console.error(`[AgentCoordinator] ${msg}`)
    return { success: false, error: msg }
  }

  try {
    const result = await handler(opts)
    console.log(`[AgentCoordinator] completed: ${opts.capabilityKey}`, {
      success: result.success,
    })
    return result
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[AgentCoordinator] error in ${opts.capabilityKey}:`, msg)
    return { success: false, error: msg }
  }
}

/** Pipeline 名称约定 */
const PIPELINE_NAMES: Record<string, string> = {
  l1: 'L1-配置类',
  l2: 'L2-代码缺陷',
  l3: 'L3-业务逻辑',
}

export async function handleAnalysisComplete(reportId: number, level: string, issueId: number, initiatorId?: string): Promise<void> {
  console.log(`[AgentCoordinator] analysis complete: report=${reportId}, level=${level}, issue=${issueId}, initiator=${initiatorId}`)

  const pipelineName = PIPELINE_NAMES[level]

  if (!pipelineName) {
    console.log(`[AgentCoordinator] L4 issue ${issueId}: needs manual handling, no auto-action`)
    return
  }

  // 查找对应等级的 Pipeline 模板
  const pipeline = await getTestPipelineByName(pipelineName)

  if (pipeline) {
    // 获取问题摘要
    const report = await getBugAnalysisReportByIssueId(issueId)
    const summary = report?.rootCauseSummary
      ? report.rootCauseSummary.slice(0, 100)
      : `Issue #${issueId}`

    const triggeredBy = initiatorId || 'agent-coordinator'

    // Pipeline 模式：通过 Pipeline 引擎执行修复流程
    console.log(`[AgentCoordinator] starting pipeline "${pipelineName}" for issue ${issueId}`)
    runPipeline(
      pipeline.id,
      {},  // 无需服务器（capability-only pipeline）
      'api',
      triggeredBy,
      (result) => {
        console.log(`[AgentCoordinator] pipeline "${pipelineName}" completed: ${result.status}`, {
          issueId, reportId, runId: result.runId,
        })
      },
      { reportId, issueId },
      summary
    ).catch(err => console.error(`[AgentCoordinator] pipeline "${pipelineName}" error:`, err))
  } else {
    // 降级：直接 triggerCapability（Pipeline 模板不存在时）
    console.warn(`[AgentCoordinator] pipeline "${pipelineName}" not found, falling back to direct trigger`)
    const capabilityKey = `fix_bug_${level}`
    triggerCapability({
      capabilityKey,
      context: {
        taskId: `auto-${Date.now()}`,
        groupId: 'system',
        platform: 'system',
        initiatorId: 'agent-coordinator',
        initiatorRole: 'admin',
      },
      extraParams: { reportId, issueId },
    }).catch(err => console.error(`[AgentCoordinator] ${capabilityKey} trigger error:`, err))
  }
}

// 通知回调（由 server.ts 注入 IM adapter 的 sendDirectMessage）
type NotifyDmFn = (userId: string, message: string) => Promise<void>
let notifyDmFn: NotifyDmFn | null = null
export function setNotifyDmFn(fn: NotifyDmFn): void { notifyDmFn = fn }

export async function handleFixComplete(issueId: number, mrId: number, projectPath?: string): Promise<void> {
  console.log(`[AgentCoordinator] fix complete: issue=${issueId}, mr=${mrId}`)

  const result = await triggerCapability({
    capabilityKey: 'ai_review_mr',
    context: {
      taskId: `review-${mrId}`,
      groupId: 'system',
      platform: 'system',
      initiatorId: 'agent-coordinator',
      initiatorRole: 'admin',
    },
    extraParams: { mrIid: mrId, projectPath },
  }).catch(err => {
    console.error('[AgentCoordinator] ai_review_mr trigger error:', err)
    return null
  })

  // Review 完成后 DM 通知模块负责人
  if (result && notifyDmFn) {
    const label = (result.data as any)?.label ?? 'unknown'
    const gitlabUrl = process.env.GITLAB_URL ?? ''
    const mrUrl = `${gitlabUrl}/${projectPath}/-/merge_requests/${mrId}`
    const statusText = label === 'ai-approved'
      ? 'AI Review 通过，请确认后合并'
      : 'AI Review 发现问题，请关注'

    // 查找模块负责人
    const report = await getBugAnalysisReportByIssueId(issueId).catch(() => null)
    if (report) {
      const modules = report.affectedModules ?? []
      const owner = modules.length > 0 ? await findOwner(report.productLineId, modules[0]) : null
      const ownerUserId = owner?.ownerUserId

      if (ownerUserId) {
        await notifyDmFn(ownerUserId, `**MR !${mrId}** ${statusText}\n\n${mrUrl}`).catch(err =>
          console.error('[AgentCoordinator] DM 通知失败:', err)
        )
        console.log(`[AgentCoordinator] DM 通知已发送: ${ownerUserId}`)
      }
    }
  }
}
