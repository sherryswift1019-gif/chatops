/**
 * prd_notify — pipeline stage 3。
 *
 * 职责（PRD §3.4）：
 *   1. 汇总 prd_submit_events 判定场景：passed / blocked / failed
 *   2. 直接用 imUserId（钉钉 userId）发 DM —— 与 notify_bug 用 owner_id 同模式
 *   3. 构造消息（含 sourceBranch → targetBranch、mrFilePath、merge 状态提示）
 *   4. 通过 IM adapter.sendDirectMessage 发 DM，不走群
 *
 * 与 notify_bug 对齐点：
 *   - 同样用 PipelineApprovalManager 的私有 adapters[0] 字段 hack（与 §6 风险表一致）
 *   - 同样 Markdown 纯文本
 *   - 同样直接拿 dingtalk userId（notify_bug 用 owner_id；这里用 imUserId）
 *
 * 与 notify_bug 差异点：
 *   - 不复用 shouldNotifyOwners 过滤；三种场景全发 DM
 *   - 接收人是**提交者本人**（非 project owner）
 */
import type { TriggerOptions, TriggerResult } from '../coordinator.js'
import { registerCapabilityHandler } from '../coordinator.js'
import {
  createEvent,
  findBySubmission,
  type PrdSubmitEvent,
} from '../../db/repositories/prd-submit-events.js'
import { PipelineApprovalManager } from '../../pipeline/approval-manager.js'
import type { IMAdapter } from '../../adapters/im/types.js'
import { extractErrorMessage } from './errors.js'

interface Params {
  submissionId: string
  imUserId: string
}

function readParams(opts: TriggerOptions): Params | { error: string } {
  const p = opts.extraParams ?? {}
  if (!p.submissionId || typeof p.submissionId !== 'string') {
    return { error: '缺少 capabilityParams.submissionId' }
  }
  if (!p.imUserId || typeof p.imUserId !== 'string') {
    return { error: '缺少 capabilityParams.imUserId' }
  }
  return { submissionId: p.submissionId, imUserId: p.imUserId }
}

type Scenario = 'prd_submit_passed' | 'prd_submit_blocked' | 'prd_submit_failed'

interface ScenarioContext {
  kind: Scenario
  mrIid: number | null
  mrUrl: string | null
  decision: 'pass' | 'blocked' | null
  findings: Array<{ severity: string; title: string; detail?: string }>
  draftCleared: boolean
  failedStage: string | null
  errorMessage: string | null
  // 从入口事件 data 拿的路由/显示信息
  projectPath: string | null
  sourceBranch: string | null
  targetBranch: string | null
  mrFilePath: string | null
  // 群回复路由（IM 入口写入；admin/手动触发场景为 null）
  imGroupId: string | null
}

function decideScenario(events: PrdSubmitEvent[]): ScenarioContext {
  const byCode = new Map<string, PrdSubmitEvent[]>()
  for (const e of events) {
    const arr = byCode.get(e.code) ?? []
    arr.push(e)
    byCode.set(e.code, arr)
  }

  // 入口事件（记录 sourceBranch / targetBranch / mrFilePath / projectPath）
  const entry = byCode.get('prd_submit_requested')?.[0]
  const entryData = (entry?.data ?? {}) as Record<string, unknown>

  // 各 stage 最新状态
  const createMr = (byCode.get('prd_create_mr') ?? []).slice(-1)[0]
  const review = (byCode.get('prd_ai_review_mr') ?? []).slice(-1)[0]

  const createData = (createMr?.data ?? {}) as Record<string, unknown>
  const reviewData = (review?.data ?? {}) as Record<string, unknown>

  const mrIid = (createData.mrIid as number | undefined) ?? null
  const mrUrl = (createData.mrUrl as string | undefined) ?? null
  const decision = (reviewData.decision as 'pass' | 'blocked' | undefined) ?? null
  const findings = (reviewData.findings as ScenarioContext['findings'] | undefined) ?? []
  const draftCleared = (reviewData.draftCleared as boolean | undefined) ?? false

  // 失败判定：createMr 或 review 任一 failed，或 review 未跑
  let kind: Scenario
  let failedStage: string | null = null
  let errorMessage: string | null = null

  if (!createMr || createMr.status === 'failed') {
    kind = 'prd_submit_failed'
    failedStage = 'prd_create_mr'
    errorMessage = (createData.error as string | undefined) ?? 'MR 创建失败'
  } else if (!review || review.status === 'failed') {
    kind = 'prd_submit_failed'
    failedStage = 'prd_ai_review_mr'
    errorMessage = (reviewData.error as string | undefined) ?? 'AI review 失败或超时'
  } else if (decision === 'pass') {
    kind = 'prd_submit_passed'
  } else {
    kind = 'prd_submit_blocked'
  }

  return {
    kind,
    mrIid,
    mrUrl,
    decision,
    findings,
    draftCleared,
    failedStage,
    errorMessage,
    projectPath: (entryData.projectPath as string | undefined) ?? entry?.projectPath ?? null,
    sourceBranch: (entryData.sourceBranch as string | undefined) ?? null,
    targetBranch: (entryData.targetBranch as string | undefined) ?? null,
    mrFilePath: (entryData.mrFilePath as string | undefined) ?? null,
    imGroupId: (entryData.imGroupId as string | undefined) ?? null,
  }
}

function buildMessage(ctx: ScenarioContext): string {
  const refLine = ctx.sourceBranch && ctx.targetBranch
    ? `  (${ctx.sourceBranch} → ${ctx.targetBranch}; 文件: ${ctx.mrFilePath ?? '未知'})`
    : ''
  const mrLine = ctx.projectPath && ctx.mrUrl ? `- ${ctx.projectPath}: ${ctx.mrUrl}\n${refLine}` : ''

  if (ctx.kind === 'prd_submit_passed') {
    const mergeStatus = ctx.draftCleared
      ? '**已解除 Draft，可以合并**'
      : '⚠️ review 通过但解除 Draft 失败，请在 MR 页面手动移除 `Draft:` 前缀或联系管理员'
    return [
      `✅ 你提交的 PRD MR 已通过 AI review，${mergeStatus}：`,
      mrLine,
      '',
      '📋 AI Review 结论：✅ pass',
      '',
      '请在 GitLab 上完成 Approve + Merge。',
    ].join('\n')
  }

  if (ctx.kind === 'prd_submit_blocked') {
    // PRD §3.4 "findings 按 severity 取前 3 条" —— blocker 最优先，保证 DM 能看到最严重的问题
    const severityRank: Record<string, number> = { blocker: 0, warning: 1, info: 2 }
    const sortedFindings = [...ctx.findings].sort(
      (a, b) => (severityRank[a.severity] ?? 3) - (severityRank[b.severity] ?? 3),
    )
    const findingsSummary = sortedFindings.slice(0, 3).map((f, i) => {
      const sev = f.severity ? `[${f.severity}]` : ''
      return `${i + 1}. ${sev} ${f.title}`
    }).join('\n')
    return [
      '⚠️ AI Review 发现问题，**MR 保持 Draft 状态，任何人都无法 Merge**',
      '',
      '你提交的 PRD MR：',
      mrLine,
      '',
      'AI Review 结论：⚠️ blocked',
      findingsSummary ? `Findings 摘要：\n${findingsSummary}` : '',
      '',
      `请查看 MR 评论，修复后 push 到 ${ctx.sourceBranch ?? 'source 分支'} 并再次 @agent 触发新一轮 review。review 通过后 agent 会自动解除 Draft。`,
    ].filter(Boolean).join('\n')
  }

  // failed
  const header = '🛑 PRD MR 提交失败，**MR 保持 Draft（如已创建）**'
  const body = [
    `失败阶段：${ctx.failedStage ?? '未知'}`,
    `错误：${ctx.errorMessage ?? '未知'}`,
  ]
  if (mrLine) body.push('', '已创建的 MR：', mrLine)
  return [header, '', ...body, '', '请联系管理员或重新提交。'].join('\n')
}

function getFirstAdapter(mgr: PipelineApprovalManager): IMAdapter | undefined {
  const adapters = (mgr as unknown as { adapters?: IMAdapter[] }).adapters
  return adapters?.[0]
}

type SendOutcome =
  | { ok: true }
  | { ok: false; error: string }
  | { ok: false; skipped: true }

async function trySend(label: string, fn: () => Promise<void>): Promise<SendOutcome> {
  try {
    await fn()
    return { ok: true }
  } catch (err) {
    const msg = extractErrorMessage(err)
    console.error(`[prd_notify] ${label} failed:`, msg)
    return { ok: false, error: msg }
  }
}

export async function handlePrdNotify(opts: TriggerOptions): Promise<TriggerResult> {
  const parsed = readParams(opts)
  if ('error' in parsed) {
    return { success: false, error: parsed.error }
  }
  const { submissionId, imUserId } = parsed

  // 1. 汇总事件 + 场景判定
  const events = await findBySubmission(submissionId)
  const scenario = decideScenario(events)
  const projectPath = scenario.projectPath

  // 2. 构造消息（imUserId 直接用，不再反查）
  const text = buildMessage(scenario)

  // 3. 拿 adapter（复用 notify_bug 私有字段 hack）
  const mgr = PipelineApprovalManager.getInstance()
  const adapter = getFirstAdapter(mgr)
  if (!adapter) {
    await createEvent({
      submissionId, projectPath,
      code: 'prd_notify', status: 'failed',
      data: { reason: 'no_adapter', imUserId, messageKind: scenario.kind },
    })
    return { success: false, error: 'no_adapter' }
  }

  // 4. 双发：DM + 群消息（独立 best-effort，至少一个成功就算 success）
  const dm = await trySend('DM', () => adapter.sendDirectMessage(imUserId, { text }))
  const group: SendOutcome = scenario.imGroupId
    ? await trySend('group', () =>
        adapter.sendMessage({ type: 'group', id: scenario.imGroupId! }, { text }))
    : { ok: false, skipped: true }

  const overallOk = dm.ok || group.ok

  await createEvent({
    submissionId, projectPath,
    code: 'prd_notify',
    status: overallOk ? 'success' : 'failed',
    data: {
      imUserId,
      imGroupId: scenario.imGroupId,
      messageKind: scenario.kind,
      mrIid: scenario.mrIid,
      dm,
      group,
    },
  })

  if (!overallOk) {
    const dmErr = !dm.ok && 'error' in dm ? dm.error : 'unknown'
    const groupErr = group.ok ? 'ok' : 'skipped' in group ? 'no_group_id' : group.error
    return { success: false, error: `所有通道发送失败: dm=${dmErr}; group=${groupErr}` }
  }

  const sent: string[] = []
  if (dm.ok) sent.push('DM')
  if (group.ok) sent.push('group')
  return {
    success: true,
    output: `通知已发送 (${scenario.kind}) → ${sent.join(' + ')} (imUserId=${imUserId})`,
  }
}

export function registerPrdNotifyHandler(): void {
  registerCapabilityHandler('prd_notify', handlePrdNotify)
  console.log('[prd_notify] handler registered')
}
