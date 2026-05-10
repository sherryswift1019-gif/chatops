/**
 * 审批摘要模块路由入口。
 *
 * 调用方应根据 baseApprovalKind 选择合适的 builder：
 *   - 'spec' / 'escalation' → buildSpecApprovalSummary
 *   - 'plan' → buildPlanApprovalSummary
 *   - 'final' → buildFinalApprovalSummary
 *   - 其它（qi_e2e_intervention / qi_sandbox_failed）→ 返回 null（走旧逻辑）
 *
 * 设计原则：模块对外只暴露这三个 builder + helpers，不暴露内部实现细节。
 */
export { buildSpecApprovalSummary } from './spec.js'
export type { BuildSpecApprovalSummaryArgs } from './spec.js'

export { buildPlanApprovalSummary } from './plan.js'
export type { BuildPlanApprovalSummaryArgs } from './plan.js'

export { buildFinalApprovalSummary } from './final.js'
export type { BuildFinalApprovalSummaryArgs } from './final.js'

export {
  computeHeuristicHint,
  parseFeedbackForSummary,
  truncateImSummary,
  formatStandard,
  riskIcon,
} from './shared.js'

export { SpecSummaryI18n, severityOrder } from './i18n.js'
