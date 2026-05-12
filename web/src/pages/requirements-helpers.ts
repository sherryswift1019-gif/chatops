/**
 * RequirementsPage 纯函数 helpers（Phase 4 v2）。
 * 与 React 组件解耦，便于单测。
 */
import type { ApprovalWaiterDTO, ApprovalDecision, V2StageResult } from '../api/requirements'

/**
 * 审批 kind → 用户可见 label。新增 / 改文案时同步 KIND_LABEL 测试。
 * dev 是 v14 新增（dev_human_gate 不再借用 'plan' 标签）。
 */
export const KIND_LABEL: Record<string, string> = {
  spec:       'Spec 评审',
  plan:       'Plan 评审',
  dev:        'Dev 评审',
  final:      '最终审批',
  escalation: '升级审批',
  human_gate: '人工审批',
}

/**
 * 决策弹窗的 title。final 是 one-shot 不显示轮次；其他 kind 显示「第 N 轮」。
 * waiter 为空时返回空串（调用方按需 fallback）。
 */
export function buildDecisionModalTitle(waiter: ApprovalWaiterDTO | null | undefined): string {
  if (!waiter) return ''
  const label = KIND_LABEL[waiter.approvalKind] ?? waiter.approvalKind
  if (waiter.approvalKind === 'final') return label
  return `${label} · 第 ${waiter.round} 轮`
}

/**
 * 在 stageResults[] 中找当前 waiter 对应的 stage（按 name == nodeId 匹配）。
 * waiter.nodeId 形如 'spec_review_loop' / 'final_approval' / 'dev_with_review_loop'。
 * 找不到 / waiter 为 null 返回 undefined。
 */
export function findStageForWaiter(
  stageResults: V2StageResult[] | null | undefined,
  waiter: ApprovalWaiterDTO | null | undefined,
): V2StageResult | undefined {
  if (!stageResults || !waiter) return undefined
  return stageResults.find(s => s.name === waiter.nodeId)
}

/**
 * spec waiter round ≥ 2 选择 rejected → 应弹"会触发 plan 重做"提示。
 * Phase 4 验收要求：弹窗触发条件可单测。详见 02-data-flow.md §6 acDiff 级联失效。
 *
 * 触发条件（全部满足）：
 * - approvalKind === 'spec'
 * - round >= 2
 * - decision === 'rejected'
 *
 * 其他场景（final approval / 第一轮 spec / 非 rejected 决策）不弹。
 */
export function shouldWarnPlanRework(
  waiter: ApprovalWaiterDTO | null | undefined,
  decision: ApprovalDecision | null | undefined,
): boolean {
  if (!waiter || !decision) return false
  return waiter.approvalKind === 'spec' && waiter.round >= 2 && decision === 'rejected'
}

/**
 * Reject reroute 上限（与后端 graph-builder.ts REJECT_CAP 保持一致）。
 * 达上限后决策下拉 reject 选项 disabled，引导用户选 force_passed / aborted / approved。
 */
export const REJECT_CAP = 3

export interface DecisionOption {
  value: string
  label: string
  disabled?: boolean
}

/**
 * 构造决策下拉选项。
 * - waiter.decisionSet='plan_escalation' → 4-way plan escalation 老分支（不受 reject cap 影响）
 * - 其他（含 'human_gate' / 'binary'）→ 5 选项，其中 'rejected' 在 reject_counts[nodeId] ≥ REJECT_CAP 时 disable
 */
export function buildDecisionOptions(
  waiter: ApprovalWaiterDTO | null | undefined,
  retryCounters: { reject_counts?: Record<string, number> } | null | undefined,
): DecisionOption[] {
  if (!waiter) return []

  if (waiter.decisionSet === 'plan_escalation') {
    return [
      { value: 'approved',       label: '✅ 通过（plan 可用，AI 抠的是 nitpick）' },
      { value: 'rejected_plan',  label: '❌ 拒绝 plan（让 plan-decomposer 重拆）' },
      { value: 'rejected_spec',  label: '⛔ 拒绝 spec（spec 本身有问题，需手工重新提交需求）' },
      { value: 'aborted',        label: '🛑 终止（说不准 / 不该 AI 拆）' },
    ]
  }

  const rejectCount = retryCounters?.reject_counts?.[waiter.nodeId] ?? 0
  const rejectExhausted = rejectCount >= REJECT_CAP

  return [
    { value: 'approved',        label: '✅ 通过' },
    {
      value: 'rejected',
      label: rejectExhausted
        ? `❌ 拒绝（已达 ${REJECT_CAP} 轮上限，请选下方其它）`
        : '❌ 拒绝（要求修改）',
      disabled: rejectExhausted,
    },
    { value: 'force_passed',    label: '⚡ 强制通过（跳过评审）' },
    { value: 'budget_extended', label: '⏳ 延期（追加预算）' },
    { value: 'aborted',         label: '🛑 中止需求' },
  ]
}
