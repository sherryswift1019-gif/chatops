import { getCapabilityByKey } from '../db/repositories/capabilities.js'
import { findOwner } from '../db/repositories/module-owners.js'
import { getBugAnalysisReportById } from '../db/repositories/bug-analysis-reports.js'
import { getTestPipelineByName } from '../db/repositories/test-pipelines.js'
import { runPipeline } from '../pipeline/executor.js'
import type { TaskContext } from './tools/types.js'
import type { ApprovalGate } from '../approval/gate.js'

export interface TriggerOptions {
  capabilityKey: string
  context: TaskContext
  extraParams?: Record<string, unknown>
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

  // 如果该 capability 绑定了默认 pipeline，走 pipeline 驱动路径
  // （通常首节点为 im_input 参数澄清，比裸跑 Agent 具备更强的容错/审批能力）。
  if (capability.defaultPipelineId) {
    try {
      // 动态 import 避免 coordinator ↔ executor-hooks ↔ coordinator 循环依赖。
      const { runPipeline } = await import('../pipeline/executor.js')
      const runId = await runPipeline(
        capability.defaultPipelineId,
        {},  // IM 触发场景通常不预分配服务器，由 pipeline 内部按需处理
        'im',
        opts.context.initiatorId,
        {},  // runtimeVars 走 triggerParams 通道
        undefined,  // onComplete：进度反馈由 im-notifier 从 pipeline 内部推送
        opts.extraParams ?? {},
        {
          platform: opts.context.platform,
          groupId: opts.context.groupId,
          userId: opts.context.initiatorId,
        },
      )
      console.log(
        `[AgentCoordinator] pipeline run #${runId} started for capability "${opts.capabilityKey}"`,
      )
      return {
        success: true,
        output: `Pipeline run #${runId} started`,
        data: { runId, pipelineId: capability.defaultPipelineId },
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[AgentCoordinator] pipeline start failed for ${opts.capabilityKey}:`, msg)
      return { success: false, error: `启动 pipeline 失败: ${msg}` }
    }
  }

  // 降级：走原 handler 路径（capability 未绑定 pipeline）
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
  l1: 'ai-fix-l1',
  l2: 'ai-fix-l2',
  l3: 'ai-fix-l3',
}

export async function handleAnalysisComplete(reportId: number, level: string, issueId: number): Promise<void> {
  console.log(`[AgentCoordinator] analysis complete: report=${reportId}, level=${level}, issue=${issueId}`)

  const pipelineName = PIPELINE_NAMES[level]

  if (!pipelineName) {
    console.log(`[AgentCoordinator] L4 issue ${issueId}: needs manual handling, no auto-action`)
    return
  }

  // 查找对应等级的 Pipeline 模板
  const pipeline = await getTestPipelineByName(pipelineName)

  if (pipeline) {
    // Pipeline 模式：通过 Pipeline 引擎执行修复流程
    console.log(`[AgentCoordinator] starting pipeline "${pipelineName}" for issue ${issueId}`)
    runPipeline(
      pipeline.id,
      {},  // 无需服务器（capability-only pipeline）
      'api',
      'agent-coordinator',
      {},  // runtimeVarsInput
      (result) => {
        console.log(`[AgentCoordinator] pipeline "${pipelineName}" completed: ${result.status}`, {
          issueId, reportId, runId: result.runId,
        })
      },
      { reportId, issueId }
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

export async function handleFixComplete(issueId: number, mrId: number, projectPath?: string): Promise<void> {
  console.log(`[AgentCoordinator] fix complete: issue=${issueId}, mr=${mrId}`)

  await triggerCapability({
    capabilityKey: 'ai_review_mr',
    context: {
      taskId: `review-${mrId}`,
      groupId: 'system',
      platform: 'system',
      initiatorId: 'agent-coordinator',
      initiatorRole: 'admin',
    },
    extraParams: { mrIid: mrId, projectPath },
  }).catch(err => console.error('[AgentCoordinator] ai_review_mr trigger error:', err))
}
