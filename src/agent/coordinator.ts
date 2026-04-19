import { getCapabilityByKey } from '../db/repositories/capabilities.js'
import {
  getBugAnalysisReportById,
  setPipelineRunId,
  updateReportStatus,
} from '../db/repositories/bug-analysis-reports.js'
import type { TestPipeline } from '../db/repositories/test-pipelines.js'
import { findByReportCode } from '../db/repositories/bug-fix-events.js'
import { getPool } from '../db/client.js'
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

/** Pipeline 名称约定（按 level 查找 product_line 对应 Pipeline） */
const PIPELINE_NAMES: Record<string, string> = {
  l1: 'L1-配置类',
  l2: 'L2-代码缺陷',
  l3: 'L3-业务逻辑',
  l4: 'L4-复杂问题',
}

async function findPipelineByLevel(productLineId: number, level: string): Promise<TestPipeline | null> {
  const name = PIPELINE_NAMES[level]
  if (!name) return null
  const { rows } = await getPool().query(
    `SELECT * FROM test_pipelines WHERE product_line_id = $1 AND name = $2 AND enabled = true LIMIT 1`,
    [productLineId, name],
  )
  const r = rows[0]
  if (!r) return null
  return {
    id: r.id as number,
    productLineId: r.product_line_id as number,
    name: r.name as string,
    description: (r.description ?? '') as string,
    stages: (r.stages ?? []) as unknown[],
    serverRoles: (r.server_roles ?? {}) as Record<string, { count: number }>,
    schedule: (r.schedule ?? '') as string,
    enabled: r.enabled as boolean,
    triggerParams: (r.trigger_params ?? {}) as Record<string, unknown>,
    variables: (r.variables ?? {}) as Record<string, string>,
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
  }
}

/**
 * 分析完成后协调入口。
 * - 非 bug 分类：不触发 Pipeline（analyzer 内部已设 status='completed'）
 * - bug 分类：按 productLineId + level 查匹配 Pipeline，调 runPipeline
 *   - 回写 pipeline_run_id
 *   - onComplete: status='success' → pipeline_success；status='failed' → aborted + 补发 notify_bug
 *                 并在 failed 时检查最新 approval 事件，若 decision='retry_analysis' → 自动 analyze_bug 新一轮
 */
export async function handleAnalysisComplete(
  reportId: number,
  level: string,
  classification: string,
  triggeredBy: string,
): Promise<void> {
  console.log(`[AgentCoordinator] analysis complete: report=${reportId}, level=${level}, classification=${classification}`)

  // 非 bug：analyzer 里已设 status='completed'，这里什么都不做
  if (classification !== 'bug') {
    console.log(`[AgentCoordinator] skip pipeline for non-bug report ${reportId} (classification=${classification})`)
    return
  }

  const report = await getBugAnalysisReportById(reportId)
  if (!report) {
    console.error(`[AgentCoordinator] report ${reportId} not found`)
    throw new Error(`report ${reportId} not found`)
  }

  const pipeline = await findPipelineByLevel(report.productLineId, level)
  if (!pipeline) {
    console.error(`[AgentCoordinator] no pipeline for productLine=${report.productLineId} level=${level}, mark aborted`)
    await updateReportStatus(reportId, 'aborted')
    return
  }

  const onComplete = async (result: { status: 'success' | 'failed'; errorMessage?: string }): Promise<void> => {
    try {
      if (result.status === 'success') {
        await updateReportStatus(reportId, 'pipeline_success')
        console.log(`[AgentCoordinator] report ${reportId} → pipeline_success`)
        return
      }

      // Pipeline 失败 → aborted
      await updateReportStatus(reportId, 'aborted')
      console.log(`[AgentCoordinator] report ${reportId} → aborted (errorMessage=${result.errorMessage ?? ''})`)

      // 补发 notify_bug（失败时 notify_bug stage 可能未运行）
      // 幂等保护：若 Pipeline 内的 notify_bug stage 已经发过（例如 ai_review_mr
      // onFailure=continue 场景下 Pipeline 仍会跑完 notify_bug stage 并最终以
      // failed 收尾），避免 coordinator 再补发一次 → 同一 Pipeline 发两条 DM。
      // 真相源：bug_fix_events(code='notify', status='success')
      try {
        const existingNotify = await findByReportCode(reportId, 'notify')
        const alreadyNotified = existingNotify.some(e => e.status === 'success')
        if (alreadyNotified) {
          console.log(`[AgentCoordinator] report=${reportId} notify 已执行过，跳过失败补发`)
        } else {
          await triggerCapability({
            capabilityKey: 'notify_bug',
            context: {
              taskId: `notify-fail-${reportId}`,
              groupId: 'pipeline',
              platform: 'api',
              initiatorId: triggeredBy,
              initiatorRole: 'admin',
            },
            extraParams: { reportId },
          })
        }
      } catch (err) {
        console.error(`[AgentCoordinator] notify_bug on failed pipeline error:`, err)
      }

      // retry_analysis 决策 → 自动 analyze_bug 新一轮
      const approvals = await findByReportCode(reportId, 'approval')
      const lastApproval = approvals.length > 0 ? approvals[approvals.length - 1] : null
      const decision = lastApproval ? (lastApproval.data as Record<string, unknown>)?.decision : null
      if (decision === 'retry_analysis') {
        console.log(`[AgentCoordinator] retry_analysis → trigger new analyze_bug with reuseIssueId=${report.issueId}`)
        try {
          await triggerCapability({
            capabilityKey: 'analyze_bug',
            context: {
              taskId: `retry-${reportId}`,
              groupId: 'pipeline',
              platform: 'api',
              initiatorId: triggeredBy,
              initiatorRole: 'developer',
            },
            extraParams: {
              productLineId: report.productLineId,
              reuseIssueId: report.issueId,
              message: `[重新分析] 基于 Issue #${report.issueId} 的历史内容重新分析`,
            },
          })
        } catch (err) {
          console.error(`[AgentCoordinator] retry_analysis trigger error:`, err)
        }
      }
    } catch (err) {
      console.error(`[AgentCoordinator] onComplete error for report ${reportId}:`, err)
    }
  }

  const runId = await runPipeline(
    pipeline.id,
    {},  // capability-only pipeline，无需服务器
    'api',
    triggeredBy,
    onComplete,
    { reportId },
  )

  await setPipelineRunId(reportId, runId)
  console.log(`[AgentCoordinator] report ${reportId} linked to pipeline run ${runId}`)
}

// 通知回调（server.ts 仍注入；当前链路已由 notify_bug capability 负责，保留 API 兼容性）
type NotifyDmFn = (userId: string, message: string) => Promise<void>
// eslint-disable-next-line @typescript-eslint/no-unused-vars
let notifyDmFn: NotifyDmFn | null = null
export function setNotifyDmFn(fn: NotifyDmFn): void { notifyDmFn = fn }
