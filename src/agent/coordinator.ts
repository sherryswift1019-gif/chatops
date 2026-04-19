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
 * - L4 分类（MVP）：走 handover 路径，不启动 L4-复杂问题 Pipeline（V2 handover-pipeline 的前身）
 * - L1/L2/L3 分类：按 productLineId + level 查匹配 Pipeline，调 runPipeline
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

  // L4（MVP）：AI 放弃自动修复，走 handover 路径，不启动 L4-复杂问题 Pipeline
  // V2 spec §5 / §9.3：L4 对应 state draft → pending_manual（非 published → aborted）
  if (level === 'l4') {
    console.log(`[AgentCoordinator] level=l4 → trigger handover (reason=l4_manual)`)
    await checkAndTriggerHandover(reportId, 'l4_manual', triggeredBy)
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

      // Pipeline 失败 → 根据失败原因决定下一步（MVP）：
      // 1. 审批 retry_analysis → aborted + 新 analyze_bug（原逻辑）
      // 2. 审批 rejected/timeout → aborted，无通知（决策 12：不发审批相关 DM）
      // 3. fix 类失败（retryCount 耗尽） → handover(fix_exhausted)（MVP T5）
      // 4. 其他（create_mr/ai_review 失败）→ aborted + 补发 notify_bug（原逻辑）

      const approvals = await findByReportCode(reportId, 'approval')
      const lastApproval = approvals.length > 0 ? approvals[approvals.length - 1] : null
      const decision = lastApproval ? (lastApproval.data as Record<string, unknown>)?.decision : null

      // retry_analysis：触发新一轮 analyze_bug（原逻辑，顺序提前到最前判断）
      if (decision === 'retry_analysis') {
        await updateReportStatus(reportId, 'aborted')
        console.log(`[AgentCoordinator] report ${reportId} → aborted (retry_analysis triggered)`)
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
        return
      }

      // 审批 rejected/timeout：aborted，不发通知（PRD 决策 12）
      if (decision === 'rejected' || decision === 'timeout') {
        await updateReportStatus(reportId, 'aborted')
        console.log(`[AgentCoordinator] report ${reportId} → aborted (approval ${decision})`)
        return
      }

      // fix 阶段失败（retryCount 耗尽）→ handover(fix_exhausted)
      // 判定：有 fix_attempt failed 且没有 fix_attempt success（全失败）
      // 注：部分 project 成功+部分失败也算"fix_exhausted"：PRD 的 partial failure policy
      // 明确整条 Pipeline 终止 / 已成功 project 的代码丢弃，故全部进 handover 合理
      const fixAttempts = await findByReportCode(reportId, 'fix_attempt')
      const hasFailedFix = fixAttempts.some(e => e.status === 'failed')
      if (hasFailedFix) {
        const failedCount = fixAttempts.filter(e => e.status === 'failed').length
        console.log(
          `[AgentCoordinator] report=${reportId} fix 阶段失败（${failedCount} 次）→ 触发 handover(fix_exhausted)`,
        )
        await checkAndTriggerHandover(reportId, 'fix_exhausted', triggeredBy, {
          failedStage: `fix_bug_${level}`,
          attemptCount: failedCount,
        })
        return
      }

      // 其他失败（create_mr / ai_review 失败等）：aborted + 补发 notify_bug（原逻辑）
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

/**
 * 转人工接手统一入口（MVP 对齐 V2 spec §9.3）。
 * 依次触发 request_handover（写 handover 事件 + 改状态 + 打 label）和 notify_bug（发 DM 给 owner）。
 *
 * MVP 支持的 reason：'fix_exhausted' | 'l4_manual' | 'user_requested'
 * V2 spec 里还有 'revise_exhausted' | 'low_confidence' | 'owner_label' | 'tag_unrevisable'，
 * 但本期代码不触发这些。接口签名保留 string 类型，供 V2 扩展。
 *
 * 幂等：已有 handover success 事件直接跳过，避免重复触发。
 */
export async function checkAndTriggerHandover(
  reportId: number,
  reason: 'fix_exhausted' | 'l4_manual' | 'user_requested' | string,
  triggeredBy: string,
  context?: { failedStage?: string; comment?: string; attemptCount?: number },
): Promise<void> {
  // 幂等（handler 本身也有幂等；这里先查避免多次 triggerCapability 的日志噪音）
  const existing = await findByReportCode(reportId, 'handover')
  if (existing.some(e => e.status === 'success')) {
    console.log(`[AgentCoordinator] report=${reportId} already handed over, skip`)
    return
  }

  // 1. 调 request_handover：写事件 + 改状态 + GitLab 打 label
  const handoverResult = await triggerCapability({
    capabilityKey: 'request_handover',
    context: {
      taskId: `handover-${reportId}`,
      groupId: 'pipeline',
      platform: 'api',
      initiatorId: triggeredBy,
      initiatorRole: 'admin',
    },
    extraParams: { reportId, reason, ...(context ? { context } : {}) },
  })
  if (!handoverResult.success) {
    console.error(
      `[AgentCoordinator] request_handover failed for report=${reportId}: ${handoverResult.error}`,
    )
    // handover 失败不再触发 notify_bug（DM 基于 handover 事件）；让 report 停在原状态，等手动介入
    return
  }

  // 2. 调 notify_bug：读 handover 事件 + DM owner（详见 notify-handler kind='handover' 分支）
  try {
    await triggerCapability({
      capabilityKey: 'notify_bug',
      context: {
        taskId: `notify-handover-${reportId}`,
        groupId: 'pipeline',
        platform: 'api',
        initiatorId: triggeredBy,
        initiatorRole: 'admin',
      },
      extraParams: { reportId },
    })
  } catch (err) {
    console.error(`[AgentCoordinator] notify_bug on handover error for report=${reportId}:`, err)
  }
}

// 通知回调（server.ts 仍注入；当前链路已由 notify_bug capability 负责，保留 API 兼容性）
type NotifyDmFn = (userId: string, message: string) => Promise<void>
// eslint-disable-next-line @typescript-eslint/no-unused-vars
let notifyDmFn: NotifyDmFn | null = null
export function setNotifyDmFn(fn: NotifyDmFn): void { notifyDmFn = fn }
