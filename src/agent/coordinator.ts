import { getCapabilityByKey } from '../db/repositories/capabilities.js'
import { getIMTrigger } from '../db/repositories/im-triggers.js'
import {
  getBugAnalysisReportById,
  setPipelineRunId,
  updateReportStatus,
} from '../db/repositories/bug-analysis-reports.js'
import { findByReportCode } from '../db/repositories/bug-fix-events.js'
import { getProjectByGitlabPath } from '../db/repositories/projects-repo.js'
import { getInternalPipelineId } from '../db/repositories/internal-capability-pipelines.js'
import { resolvePipelineForTrigger } from '../db/repositories/pipeline-bindings.js'
import { runPipeline, apiTrigger } from '../pipeline/executor.js'
import { PipelineApprovalManager } from '../pipeline/approval-manager.js'
import type { IMAdapter } from '../adapters/im/types.js'
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

/**
 * phase 4 双轨灰度 feature flag。
 * 逗号分隔的 capability key 列表，命中则走 internal_capability_pipelines 映射的
 * pipeline 路径，否则走原 handler 路径。
 *
 * phase 4 T5 (2026-04-27): 默认值从空字符串改为 'request_handover,notify_bug,create_mr'
 * —— L1+L2+L3 三个迁移完成后默认全切 pipeline。如 production 撞 pipeline bug，
 * 设 PIPELINE_DAG_HANDLERS='' 即整体回退到 handler 路径（handler 文件本期保留）。
 *
 * 每次读取 process.env（不在 module load 时 freeze），方便测试用 process.env
 * 动态切换灰度集合做行为对等比较（见 T2/T3/T4 行为对等测试）。
 */
const PIPELINE_DAG_HANDLERS_DEFAULT = 'request_handover,notify_bug,create_mr'

function isPipelineDagEnabled(capabilityKey: string): boolean {
  const raw = process.env.PIPELINE_DAG_HANDLERS ?? PIPELINE_DAG_HANDLERS_DEFAULT
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(capabilityKey)
}

let approvalGate: ApprovalGate | null = null
export function setApprovalGate(gate: ApprovalGate): void { approvalGate = gate }

/**
 * 给从仓库 owner 发 L3 审批 FYI 知情消息（非审批，纯通知）。
 *
 * 从仓库 owner 列表来源：scope_identified 事件里 `projectPath !== primaryProjectPath`
 * 的条目，反查 project.ownerId，去重，排除主 owner。
 *
 * 副作用隔离：失败不抛——调用方用 `.catch(...)` 包，不阻塞主 pipeline 启动。
 */
async function sendL3FyiToSecondaryOwners(report: {
  id: number
  productLineId: number
  primaryProjectPath: string | null
  issueUrl: string
  rootCauseSummary: string | null
}): Promise<void> {
  if (!report.primaryProjectPath) return

  const primaryProject = await getProjectByGitlabPath(report.primaryProjectPath)
  const primaryOwnerId =
    (primaryProject?.ownerId && primaryProject.ownerId !== ''
      ? primaryProject.ownerId
      : null)
    ?? ''
  const primaryOwnerName = primaryProject?.ownerName || primaryOwnerId || '未知'

  const scopes = await findByReportCode(report.id, 'scope_identified')
  const otherOwnerIds = new Set<string>()
  for (const s of scopes) {
    if (!s.projectPath || s.projectPath === report.primaryProjectPath) continue
    const proj = await getProjectByGitlabPath(s.projectPath)
    const oid =
      (proj?.ownerId && proj.ownerId !== '' ? proj.ownerId : null)
      ?? null
    if (oid && oid !== primaryOwnerId) otherOwnerIds.add(oid)
  }
  if (otherOwnerIds.size === 0) return

  const mgr = PipelineApprovalManager.getInstance()
  // 双重断言访问 approval-manager 的 private adapters——硬约束文件不能加 public
  // getter（原 approve-l3-handler 里同样用法）。FYI 失败不影响主审批。
  const adapter = (mgr as unknown as { adapters?: IMAdapter[] }).adapters?.[0]
  if (!adapter) return

  const text = buildL3FyiMessage({
    issueUrl: report.issueUrl,
    primaryProjectPath: report.primaryProjectPath,
    primaryOwnerName,
    summary: (report.rootCauseSummary ?? '').slice(0, 200),
  })
  const dmResults = await Promise.allSettled(
    Array.from(otherOwnerIds).map(oid =>
      adapter.sendDirectMessage(oid, { text }),
    ),
  )
  const failedDms = dmResults
    .map((r, i) => (r.status === 'rejected' ? { oid: Array.from(otherOwnerIds)[i], err: r.reason } : null))
    .filter((x): x is { oid: string; err: unknown } => x !== null)
  if (failedDms.length > 0) {
    for (const f of failedDms) {
      console.error('[AgentCoordinator] L3 FYI DM failed for', f.oid, f.err)
    }
    console.warn(
      `[AgentCoordinator] L3 FYI DM: ${failedDms.length}/${otherOwnerIds.size} 失败（仍视为部分成功，pipeline 继续）`,
    )
  }
}

function buildL3FyiMessage(p: {
  issueUrl: string
  primaryProjectPath: string
  primaryOwnerName: string
  summary: string
}): string {
  return [
    'L3 修复方案知情',
    '',
    `Bug 涉及你负责的服务（非主仓库），主负责人 ${p.primaryOwnerName} 正在审批方案。`,
    '',
    `Issue: ${p.issueUrl}`,
    `主仓库: ${p.primaryProjectPath}`,
    '',
    `方案摘要: ${p.summary}`,
    '',
    '如对方案有疑问，请直接联系主负责人。',
  ].join('\n')
}

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

  // IM 触发器路由：优先查 im_triggers 表。
  // 有 im_trigger → 必须显式配置 pipeline_id 或 capability_key；两者均空时报错（不静默降级）。
  // 无 im_trigger → 走下面的 PIPELINE_DAG_HANDLERS 和 handler 路径（内部 capability）。
  const imTrigger = await getIMTrigger(opts.capabilityKey)
  if (imTrigger) {
    if (imTrigger.pipelineId) {
      try {
        // 动态 import 避免 coordinator ↔ executor-hooks ↔ coordinator 循环依赖。
        const { runPipeline, imTrigger: imTriggerCtx } = await import('../pipeline/executor.js')
        const runId = await runPipeline(
          imTrigger.pipelineId,
          {},  // IM 触发场景通常不预分配服务器，由 pipeline 内部按需处理
          imTriggerCtx({
            triggeredBy: opts.context.initiatorId,
            platform: opts.context.platform,
            groupId: opts.context.groupId,
            userId: opts.context.initiatorId,
            params: opts.extraParams ?? {},
          }),
          {},  // runtimeVars 走 trigger.params 通道
          undefined,  // onComplete：进度反馈由 im-notifier 从 pipeline 内部推送
        )
        console.log(
          `[AgentCoordinator] pipeline run #${runId} started for "${opts.capabilityKey}" (via im_trigger)`,
        )
        return {
          success: true,
          output: `Pipeline run #${runId} started`,
          data: { runId, pipelineId: imTrigger.pipelineId },
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[AgentCoordinator] pipeline start failed for ${opts.capabilityKey}:`, msg)
        return { success: false, error: `启动 pipeline 失败: ${msg}` }
      }
    }

    if (imTrigger.capabilityKey) {
      const handler = handlers.get(imTrigger.capabilityKey)
      if (!handler) {
        const msg = `im trigger "${opts.capabilityKey}" 关联的 capability "${imTrigger.capabilityKey}" 未注册 handler`
        console.error(`[AgentCoordinator] ${msg}`)
        return { success: false, error: msg }
      }
      try {
        const result = await handler({ ...opts, capabilityKey: imTrigger.capabilityKey })
        console.log(`[AgentCoordinator] completed: ${opts.capabilityKey} (via im_trigger.capabilityKey=${imTrigger.capabilityKey})`, {
          success: result.success,
          ...(result.success ? {} : { error: result.error }),
        })
        return result
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[AgentCoordinator] error in ${opts.capabilityKey} (via im_trigger):`, msg)
        return { success: false, error: msg }
      }
    }

    // IM 触发器存在但两者均为空：配置缺失，明确报错
    const msg = `im trigger "${opts.capabilityKey}" 未配置执行目标（pipeline_id 或 capability_key 均为空）`
    console.error(`[AgentCoordinator] ${msg}`)
    return { success: false, error: msg }
  }

  // im_trigger 不存在：内部 capability（fix_bug、analyze_bug 等），走原有路径。
  // phase 4 双轨：PIPELINE_DAG_HANDLERS feature flag 命中且 internal_capability_pipelines
  // 有映射 → 走 pipeline 路径；缺映射时退化到 handler（不静默吞掉，打 warn 便于排查配置错误）。
  // T5 (2026-04-27) 起默认含 'request_handover,notify_bug,create_mr' —— 这 3 个 capability
  // 默认走 pipeline。回滚 = export PIPELINE_DAG_HANDLERS=""，立刻回到 handler 路径。
  if (isPipelineDagEnabled(opts.capabilityKey)) {
    const pipelineId = await getInternalPipelineId(opts.capabilityKey)
    if (pipelineId) {
      return await runPipelineAsCapability(pipelineId, opts)
    }
    console.warn(
      `[AgentCoordinator] PIPELINE_DAG_HANDLERS includes "${opts.capabilityKey}" but no internal_capability_pipelines mapping; falling back to handler`,
    )
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
      ...(result.success ? {} : { error: result.error, output: result.output }),
    })
    return result
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[AgentCoordinator] error in ${opts.capabilityKey}:`, msg)
    return { success: false, error: msg }
  }
}

/**
 * phase 4 — PIPELINE_DAG_HANDLERS 命中后的 pipeline 启动入口。
 *
 * 把 capability 的 extraParams 当作 trigger.params 透传给 pipeline；
 * 同时把可序列化的 extraParams 转 string 后塞进 runtimeVars，方便节点模板里
 * 用 {{vars.xxx}} 和 {{triggerParams.xxx}} 两种语法都能拿到。
 *
 * 失败 = 抛出的异常被吞，转为 TriggerResult.error；调用方 (triggerCapability)
 * 不会因为 pipeline 启动失败而静默——错误体里带 message。
 */
async function runPipelineAsCapability(
  pipelineId: number,
  opts: TriggerOptions,
): Promise<TriggerResult> {
  try {
    const runtimeVars: Record<string, string> = {}
    for (const [k, v] of Object.entries(opts.extraParams ?? {})) {
      runtimeVars[k] = v == null ? '' : String(v)
    }
    const runId = await runPipeline(
      pipelineId,
      {}, // 无服务器分配 (internal pipeline 不依赖产线 server_roles)
      apiTrigger({
        triggeredBy: opts.context.initiatorId,
        params: opts.extraParams ?? {},
      }),
      runtimeVars,
      undefined,
    )
    console.log(
      `[AgentCoordinator] pipeline run #${runId} started for "${opts.capabilityKey}" (PIPELINE_DAG_HANDLERS flag)`,
    )
    return {
      success: true,
      output: `Pipeline run #${runId} started`,
      data: { runId, pipelineId },
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(
      `[AgentCoordinator] runPipelineAsCapability failed for ${opts.capabilityKey}:`,
      msg,
    )
    return { success: false, error: msg }
  }
}

/**
 * runner 触发 analyze_bug 完成后的后置钩子：若 result 含 (reportId, level, classification)，
 * 转调 handleAnalysisComplete 把 Pipeline 拉起来。
 * 调用方应 fire-and-forget（`void maybeCompleteAnalyze(...).catch(...)`）。
 */
export async function maybeCompleteAnalyze(
  result: TriggerResult,
  initiatorId: string,
): Promise<void> {
  if (!result.success || !result.data) return
  const d = result.data as { reportId?: unknown; level?: unknown; classification?: unknown }
  if (typeof d.reportId !== 'number' || typeof d.level !== 'string' || typeof d.classification !== 'string') return
  await handleAnalysisComplete(d.reportId, d.level, d.classification, initiatorId)
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

  const refKey = `fix_bug_${level}`
  const binding = await resolvePipelineForTrigger(report.productLineId, refKey)
  if (!binding) {
    console.error(`[AgentCoordinator] no pipeline binding for productLine=${report.productLineId} ref_key=${refKey}, mark aborted`)
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
      // 判定：存在至少一个 scope project 的所有 fix_attempt 都 failed（从未 success）
      // 注：
      // - fix-runner 对已 success 的 project 会跳过（幂等），因此后续 retry 只重跑未成功的 project
      // - 若所有 scope 都有过 success 的 fix_attempt，则 pipeline 失败根因不在 fix（可能是 create_mr / ai_review）
      // - 若任一 scope 从未 success 过，则 fix 阶段确实耗尽 → handover
      const scopes = await findByReportCode(reportId, 'scope_identified')
      const fixAttempts = await findByReportCode(reportId, 'fix_attempt')
      const scopePaths = Array.from(
        new Set(scopes.map(s => s.projectPath).filter((p): p is string => !!p)),
      )
      const fixExhausted =
        scopePaths.length > 0 &&
        scopePaths.some(
          path =>
            fixAttempts.some(e => e.projectPath === path && e.status === 'failed') &&
            !fixAttempts.some(e => e.projectPath === path && e.status === 'success'),
        )
      if (fixExhausted) {
        const failedAttempts = fixAttempts.filter(e => e.status === 'failed')
        const failedCount = failedAttempts.length
        // 聚合每个 project 最后一次 failed 的 error，作为 handover 事件的 failureSummary。
        // 按 projectPath 分组取最后一条（fix-runner 顺序写入，数组末尾 = 最新 attempt）。
        const lastErrByProject = new Map<string, string>()
        for (const ev of failedAttempts) {
          const path = ev.projectPath ?? '(unknown)'
          const err = (ev.data as Record<string, unknown> | null)?.error
          if (typeof err === 'string' && err.length > 0) {
            lastErrByProject.set(path, err)
          }
        }
        const failureSummary = Array.from(lastErrByProject.entries())
          .map(([path, err]) => `${path}: ${err.slice(0, 200)}`)
          .join('\n')
          .slice(0, 1000) || undefined
        console.log(
          `[AgentCoordinator] report=${reportId} fix 阶段失败（${failedCount} 次，存在 project 全部 attempt 失败）→ 触发 handover(fix_exhausted)`,
        )
        await checkAndTriggerHandover(reportId, 'fix_exhausted', triggeredBy, {
          failedStage: `fix_bug_${level}`,
          attemptCount: failedCount,
          failureSummary,
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

  // L3 pipeline 的审批人查询 / 审批卡片 description 都由 approval resolver 负责
  //（src/agent/approval/resolvers.ts:primary_project_owner）。coordinator 只保留
  // FYI DM 副作用——告知非主仓库 owner 审批正在进行，让他们对方案有知情。
  // 失败不阻塞主流程：owner 收不到 FYI 不影响主 owner 的审批决策。
  if (level === 'l3') {
    await sendL3FyiToSecondaryOwners(report).catch(err => {
      console.error('[AgentCoordinator] L3 FYI DM 发送失败（不阻塞主流程）:', err)
    })
  }

  const runId = await runPipeline(
    binding.pipelineId,
    binding.serverRoleAssignments,
    apiTrigger({ triggeredBy, params: { reportId } }),
    // runtimeVars: 把 reportId 同时写进 runtime 变量（test_runs.runtime_vars），
    // 这样 resume 时 reloadContext 能合并回 triggerParams——approval node 在
    // interrupt 后的 replay 仍能拿到 reportId（否则 pipeline.triggerParams 的
    // 静态模板 {reportId: null} 会覆盖，resolver 查不到 report）
    { reportId: String(reportId) },
    onComplete,
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
  context?: { failedStage?: string; comment?: string; attemptCount?: number; failureSummary?: string },
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
let notifyDmFn: NotifyDmFn | null = null
export function setNotifyDmFn(fn: NotifyDmFn): void { notifyDmFn = fn }

// 主动给用户发 IM 私聊。无 adapter 注入时 noop（测试/未配置 IM 的场景）。
// 调用方应用 catch 包住避免发送失败影响主流程。
export async function notifyDm(userId: string, message: string): Promise<void> {
  if (!notifyDmFn) {
    console.warn('[coordinator] notifyDm not configured, skipping DM to', userId)
    return
  }
  await notifyDmFn(userId, message)
}
