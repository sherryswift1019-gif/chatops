/**
 * QI Approval Manager
 *
 * 桥接 QI_APPROVAL_INTERRUPT 与钉钉互动卡片：
 *   1. dispatchInterrupt 调 sendQiApprovalCard → 向 approverIds 发卡片
 *   2. 钉钉按钮点击 → server.ts onCardAction → handleQiCardCallback
 *   3. handleQiCardCallback → claimWaiter → resumeFromQiApproval → 流水线继续
 *
 * 路由判定：isQiApproval(outTrackId) 供 server.ts 区分 pipeline / qi / gate 三条路。
 */
import { randomUUID } from 'crypto'
import type { IMAdapter } from '../adapters/im/types.js'
import {
  claimWaiter,
  type ApprovalDecision,
  type RequirementApprovalWaiter,
} from '../db/repositories/requirement-approval-waiters.js'

export type QiApprovalResumeCallback = (
  waiterId: number,
  waiter: RequirementApprovalWaiter,
) => Promise<void>

/** outTrackId (钉钉幂等 key) → waiterId */
const cardToWaiter = new Map<string, number>()

let _adapters: IMAdapter[] = []
let _resume: QiApprovalResumeCallback | null = null

export function initQiApprovalManager(
  adapters: IMAdapter[],
  resume: QiApprovalResumeCallback,
): void {
  _adapters = adapters
  _resume = resume
}

/**
 * 把 approvalKind（+ 可选 kindMeta）映射为 IM 卡片标题里的中文标签。
 *
 * human_gate 是通用人审节点，按 kindMeta.source（'ai_pass'/'ai_escalation'/'final'）
 * 推子标签；其它 approvalKind 走固定字典。未识别的 kind 回退 '升级审批'。
 *
 * 调用方：sendQiApprovalCard（IM 卡片）；测试可直接 import 验证标签。
 */
export function getKindLabel(
  approvalKind: string,
  kindMeta?: Record<string, unknown> | null,
): string {
  if (approvalKind === 'spec') return 'Spec 评审'
  if (approvalKind === 'plan') return 'Plan 评审'
  if (approvalKind === 'final') return '最终确认'
  if (approvalKind === 'qi_e2e_intervention') return 'E2E 失败人工介入'
  if (approvalKind === 'qi_sandbox_failed') return 'Sandbox 启动失败'
  if (approvalKind === 'human_gate') {
    const source = String((kindMeta?.source as string) ?? '')
    if (source === 'ai_pass') return '人工审核'
    if (source === 'ai_escalation') return '人工裁决（AI 多轮未过）'
    if (source === 'final') return '最终批准'
    return '人工审批'
  }
  return '升级审批'
}

/**
 * 发送钉钉互动卡片给每个 approverId。
 * 无 adapter 时静默跳过（纯 Web 审批模式）。
 *
 * approvalKind:
 *   - 'spec' / 'final' / 其它 — 经典 Spec/最终评审 (binary: agree/reject)
 *   - 'qi_e2e_intervention' — QI E2E 第 3 轮人工介入 (3 按钮: fix/force_pass/abort)
 *   - 'qi_sandbox_failed' — sandbox provision 失败 (2 按钮: retry/abort)
 */
export async function sendQiApprovalCard(params: {
  waiterId: number
  requirementId: number
  requirementTitle: string
  contextSummary: string | null
  /** v3 IM 卡片精简摘要（≤ 250 字符）；优先用此字段，缺失则降级用 contextSummary 截断 1500 字 */
  imSummary?: string | null
  approvalKind: string
  /** 决定按钮集；缺省回退按 approvalKind 推（向后兼容）。PRD §7 step 4 起新增 'plan_escalation'。 */
  decisionSet?: string
  approverIds: string[]
  /** human_gate 子标签元数据（source: 'ai_pass' | 'ai_escalation' | 'final'），供 kindLabel 推子标题。 */
  kindMeta?: Record<string, unknown> | null
}): Promise<void> {
  const adapter = _adapters[0]
  if (!adapter || params.approverIds.length === 0) return

  const trackId = randomUUID()
  cardToWaiter.set(trackId, params.waiterId)

  const kindLabel = getKindLabel(params.approvalKind, params.kindMeta)

  // body 优先 imSummary（v3 精简版 ≤ 250 字符，移动端一屏可见）；否则降级 contextSummary 截断 1500
  const body = params.imSummary
    ? params.imSummary
    : (() => {
        const rawBody = params.contextSummary ?? `需求 #${params.requirementId}: ${params.requirementTitle}`
        return rawBody.length > 1500 ? rawBody.slice(0, 1500) + '\n\n…（内容过长，请在 Web 端查看完整 Spec）' : rawBody
      })()

  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const now = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`

  // 按 approvalKind / decisionSet 分发不同 actions
  const actions = buildCardActions(params.approvalKind, params.decisionSet)

  const card = {
    title: `🤖 Quick-Impl ${kindLabel}`,
    body,
    actions,
    callbackData: { taskId: trackId, qiApproval: 'true' },
    templateParams: {
      title: `Quick-Impl ${kindLabel} — #${params.requirementId} ${params.requirementTitle}`,
      body,
      createTime: now,
      status: 'pending',
    },
  }

  await Promise.all(
    params.approverIds.map(async userId => {
      try {
        await adapter.sendDirectMessage(userId, card)
      } catch (cardErr) {
        // 互动卡片失败（模板未配置等）→ 降级为 Markdown 文本 DM
        console.warn(`[qi-approval-manager] interactive card failed for ${userId}, falling back to text DM:`, (cardErr as Error).message)
        const webBase = (process.env.WEB_BASE_URL ?? '').replace(/\/$/, '')
        const approvalLink = webBase
          ? `${webBase}/requirements?id=${params.requirementId}&openWaiter=${params.waiterId}`
          : `（请打开管理后台 → 需求列表 → #${params.requirementId}）`
        const textBody = [
          `**🤖 Quick-Impl ${kindLabel}** — 需求 #${params.requirementId}: ${params.requirementTitle}`,
          '',
          body.length > 800 ? body.slice(0, 800) + '\n…（内容过长）' : body,
          '',
          `📋 审批链接：${approvalLink}`,
        ].join('\n')
        await adapter.sendDirectMessage(userId, { text: textBody }).catch(dmErr => {
          console.warn(`[qi-approval-manager] text DM also failed for ${userId}:`, dmErr)
        })
      }
    }),
  )

  console.log(
    `[qi-approval-manager] card sent to [${params.approverIds.join(', ')}]`,
    `trackId=${trackId} waiterId=${params.waiterId} kind=${params.approvalKind}`,
  )
}

/**
 * 按 approvalKind / decisionSet 决定卡片按钮集。
 *
 * 钉钉模板按钮 value 是触发 callback 时透传的 action 字符串，dingtalk.ts 会做归一化。
 * 这里 value 用 chatops 内部 ApprovalDecision 名（fix / force_passed / aborted / retry）。
 *
 * decisionSet 优先级高于 approvalKind（plan kind 在 plan_escalation decisionSet 下走新分支）。
 */
function buildCardActions(approvalKind: string, decisionSet?: string): Array<{
  label: string
  value: string
  style: 'primary' | 'danger' | 'default'
}> {
  // PRD §7 step 4：plan_human_escalation 4-way 决策（IM 简化为 2 按钮，Web 给 4 选项；
  // IM 上的"拒绝"默认归 plan 锅，spec/aborted 仅 Web 触发）
  if (decisionSet === 'plan_escalation') {
    return [
      { label: '✅ 通过', value: 'agree', style: 'primary' },
      { label: '❌ 拒绝（plan 问题）', value: 'reject_plan', style: 'danger' },
    ]
  }
  if (approvalKind === 'qi_e2e_intervention') {
    return [
      { label: '🔁 再修一轮', value: 'fix', style: 'primary' },
      { label: '⚠️ 强制通过', value: 'force_passed', style: 'danger' },
      { label: '❌ 终止', value: 'aborted', style: 'default' },
    ]
  }
  if (approvalKind === 'qi_sandbox_failed') {
    return [
      { label: '🔁 重试', value: 'retry', style: 'primary' },
      { label: '❌ 终止', value: 'aborted', style: 'default' },
    ]
  }
  // 经典 binary
  return [
    { label: '✅ 通过', value: 'agree', style: 'primary' },
    { label: '❌ 拒绝', value: 'reject', style: 'danger' },
  ]
}

/** server.ts onCardAction 路由判断 */
export function isQiApproval(outTrackId: string): boolean {
  return cardToWaiter.has(outTrackId)
}

/**
 * 钉钉卡片按钮回调入口。
 * action 已由 dingtalk.ts 归一化（agree→approved / reject→rejected / fix/force_passed/aborted/retry 直通）。
 *
 * 支持的 decision 值（按 approvalKind 不同有不同子集）：
 *   - approved/rejected — 经典 binary
 *   - fix/force_passed/aborted — qi_e2e_intervention 三按钮
 *   - retry/aborted — qi_sandbox_failed 二按钮
 */
export async function handleQiCardCallback(
  outTrackId: string,
  action: string,
  approverId: string,
): Promise<void> {
  const waiterId = cardToWaiter.get(outTrackId)
  if (waiterId == null) return
  cardToWaiter.delete(outTrackId)

  const decision = parseDecision(action)
  if (!decision) {
    console.warn(`[qi-approval-manager] unknown action "${action}" for waiter ${waiterId}, dropping`)
    return
  }

  const result = await claimWaiter(waiterId, 'im', {
    decision,
    decidedBy: approverId,
    rejectReason: null,
    budgetDelta: null,
  })

  if (!result.claimed) {
    console.warn(`[qi-approval-manager] waiter ${waiterId} already claimed by ${result.by}`)
    return
  }

  if (!_resume) {
    console.warn('[qi-approval-manager] no resume callback registered; waiter claimed but pipeline not resumed')
    return
  }

  await _resume(waiterId, result.waiter!).catch(err => {
    console.error(`[qi-approval-manager] resume failed for waiterId=${waiterId}:`, err)
  })

  console.log(`[qi-approval-manager] waiter ${waiterId} claimed & resumed by ${approverId} (${decision})`)
}

/**
 * 把钉钉/web 传入的 action 字符串归一化成 ApprovalDecision。
 *
 * 注意：'retry' 不是 ApprovalDecision 枚举值（它是 ClaimSource），
 * qi_sandbox_failed 卡片用 'retry' 触发节点重跑——映射到 'fix'（最近义；
 * dev_loop_for_e2e_fix 不会被触发，im_input 节点收到 fix 后回流到 qi_e2e_runner）。
 */
function parseDecision(action: string): ApprovalDecision | null {
  if (action === 'agree' || action === 'approved') return 'approved'
  if (action === 'reject' || action === 'rejected') return 'rejected'
  if (action === 'reject_plan' || action === 'rejected_plan') return 'rejected_plan'
  if (action === 'fix' || action === 'retry') return 'fix'
  if (action === 'force_passed' || action === 'force_pass') return 'force_passed'
  if (action === 'aborted' || action === 'abort') return 'aborted'
  return null
}

/** 测试辅助 */
export function clearQiApprovalCards(): void {
  cardToWaiter.clear()
}
