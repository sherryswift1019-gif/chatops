import type { RequirementStatus, ApprovalWaiterDTO, V2StageResult } from '../../api/requirements'
import { resolveNodeId } from './node-id-resolver'

export interface EffectiveStatus {
  label: string
  color: string
  tone: 'default' | 'processing' | 'success' | 'warning' | 'error'
}

// 13 个 RequirementStatus 的唯一 label/color 来源；RequirementsPage filter 下拉也用
export const STATUS_LABELS: Record<RequirementStatus, EffectiveStatus> = {
  draft:       { label: '草稿',     color: 'default',    tone: 'default' },
  queued:      { label: '排队中',   color: 'processing', tone: 'processing' },
  spec_review: { label: '需求审核', color: 'gold',       tone: 'warning' },
  planning:    { label: '规划中',   color: 'cyan',       tone: 'processing' },
  developing:  { label: '开发中',   color: 'blue',       tone: 'processing' },
  reviewing:   { label: '代码审核', color: 'purple',     tone: 'warning' },
  testing:     { label: '测试中',   color: 'geekblue',   tone: 'processing' },
  mr_pending:  { label: 'MR 待审',  color: 'lime',       tone: 'processing' },
  mr_open:     { label: 'MR 已开',  color: 'success',    tone: 'success' },
  merged:      { label: '已合入',   color: 'success',    tone: 'success' },
  aborting:    { label: '中止中',   color: 'warning',    tone: 'warning' },
  aborted:     { label: '已中止',   color: 'default',    tone: 'default' },
  failed:      { label: '失败',     color: 'error',      tone: 'error' },
}

const WAITER_KIND_LABEL: Record<ApprovalWaiterDTO['approvalKind'], EffectiveStatus> = {
  spec:                  { label: 'Spec 等你决策',         color: 'gold',   tone: 'warning' },
  plan:                  { label: 'Plan 等你决策',         color: 'gold',   tone: 'warning' },
  dev:                   { label: 'Dev 等你决策',          color: 'gold',   tone: 'warning' },
  final:                 { label: '最终审批 等你决策',     color: 'gold',   tone: 'warning' },
  qi_e2e_intervention:   { label: 'E2E 失败 等人工介入',   color: 'orange', tone: 'warning' },
  qi_sandbox_failed:     { label: 'Sandbox 失败 等介入',   color: 'orange', tone: 'warning' },
  human_gate:            { label: '等你决策',              color: 'gold',   tone: 'warning' },
  escalation:            { label: 'AI 升级 等决策',        color: 'gold',   tone: 'warning' },
}

const NODE_RUNNING_LABEL: Record<string, EffectiveStatus> = {
  init_branch:        { label: '初始化分支中',    color: 'default',  tone: 'processing' },
  spec_brainstorm:    { label: 'Spec 头脑风暴中',  color: 'cyan',     tone: 'processing' },
  spec_author:        { label: 'Spec 生成中',     color: 'cyan',     tone: 'processing' },
  spec_ai_review:     { label: 'Spec AI 审查中',  color: 'cyan',     tone: 'processing' },
  spec_commit_push:   { label: 'Spec 提交中',     color: 'cyan',     tone: 'processing' },
  plan_author:        { label: 'Plan 生成中',     color: 'purple',   tone: 'processing' },
  plan_ai_review:     { label: 'Plan AI 审查中',  color: 'purple',   tone: 'processing' },
  plan_commit_push:   { label: 'Plan 提交中',     color: 'purple',   tone: 'processing' },
  dev_author:         { label: 'Dev 编码中',      color: 'blue',     tone: 'processing' },
  dev_ai_review:      { label: 'Dev AI 审查中',   color: 'blue',     tone: 'processing' },
  dev_push:           { label: 'Dev 推送中',      color: 'blue',     tone: 'processing' },
  qi_e2e_runner:      { label: 'E2E 测试中',      color: 'geekblue', tone: 'processing' },
  dev_fix_author:     { label: 'E2E 失败修复中',  color: 'orange',   tone: 'processing' },
  dev_fix_ai_review:  { label: '修复 AI 审查中',  color: 'orange',   tone: 'processing' },
  mr_create:          { label: '创建 MR 中',      color: 'lime',     tone: 'processing' },
  cleanup:            { label: '清理中',          color: 'default',  tone: 'processing' },
}

interface MinimalDetail {
  status: RequirementStatus
  waiters?: ApprovalWaiterDTO[]
  stageResults?: V2StageResult[] | null
}

/**
 * 从 detail 派生 UI 友好的细粒度状态：
 *   优先级：终态 > pending waiter > running 节点 > STATUS_LABELS 兜底
 *
 * 详见 docs/superpowers/specs/2026-05-12-requirement-detail-page-redesign-design.md §「状态显示策略」
 */
export function effectiveStatus(detail: MinimalDetail): EffectiveStatus {
  const { status, waiters = [], stageResults = [] } = detail

  // 1. 终态优先
  if (status === 'draft' || status === 'queued' || status === 'merged' ||
      status === 'aborted' || status === 'failed') {
    return STATUS_LABELS[status]
  }

  // 2. pending waiter（system orphan 的 claimedBy='system' 是 truthy，已被 !claimedBy 过滤）
  const pending = waiters.find(w => !w.claimedBy)
  if (pending) {
    const label = WAITER_KIND_LABEL[pending.approvalKind]
    if (label) return label
  }

  // 3. running 节点
  // stageResults.name 是后端 display name（"Spec Author"），先 resolve 成 node id 再查表
  const running = (stageResults ?? []).find(s => s.status === 'running')
  if (running) {
    const label = NODE_RUNNING_LABEL[resolveNodeId(running.name)]
    if (label) return label
  }

  // 4. 兜底
  return STATUS_LABELS[status]
}
