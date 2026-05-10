/**
 * Quick-Impl Approval Claim
 *
 * 设计：docs/prds/prd-quick-impl.md §4.2 / §6.2 / §9
 *
 * 职责：
 *   1. 校验 decision 是否在 waiter.decision_set 允许集内
 *   2. 校验 budget_extended 的 budgetDelta 范围
 *   3. 委托 repository claimWaiter 完成 DB 级 race-winner UPDATE
 *   4. 提供 shouldEscalate / computeNewBudget 两个节点辅助函数
 *
 * 依赖注入：通过 ApprovalClaimDeps 传入 repository 函数——测试用 fake，生产用真 repository。
 *
 * 调用方：POST /admin/requirements/:id/approvals/:waiterId（admin route，Day 13-14 实现）
 *        skill_with_approval 节点内部循环（Day 7-9 实现）
 */
import type {
  ApprovalDecision,
  ClaimDecisionInput,
  ClaimResult,
  ClaimSource,
  RequirementApprovalWaiter,
} from '../db/repositories/requirement-approval-waiters.js'

// =============================================================================
// 错误类型
// =============================================================================

export class ApprovalClaimError extends Error {
  constructor(
    public readonly code:
      | 'not_found'
      | 'decision_not_allowed'
      | 'budget_delta_invalid',
    message: string,
  ) {
    super(message)
    this.name = 'ApprovalClaimError'
  }
}

// =============================================================================
// 常量
// =============================================================================

const BINARY_ALLOWED: ReadonlySet<ApprovalDecision> = new Set([
  'approved',
  'rejected',
])

const ESCALATION_ALLOWED: ReadonlySet<ApprovalDecision> = new Set([
  'approved',
  'rejected',
  'force_passed',
  'budget_extended',
  'aborted',
])

// PRD §7 step 4：plan_human_escalation 的 4-way 决策——区分 plan 锅 / spec 锅 / 终止
const PLAN_ESCALATION_ALLOWED: ReadonlySet<ApprovalDecision> = new Set([
  'approved',
  'rejected_plan',
  'rejected_spec',
  'aborted',
])

export const BUDGET_DELTA_MIN = 1
export const BUDGET_DELTA_MAX = 5

// =============================================================================
// 依赖注入接口（生产用 repository，测试用 fake）
// =============================================================================

export interface ApprovalClaimDeps {
  getWaiterById: (id: number) => Promise<RequirementApprovalWaiter | null>
  claimWaiter: (
    id: number,
    source: ClaimSource,
    decision: ClaimDecisionInput,
  ) => Promise<ClaimResult>
}

// =============================================================================
// 主入口
// =============================================================================

export interface ClaimApprovalOptions {
  waiterId: number
  source: ClaimSource
  decision: ApprovalDecision
  rejectReason?: string | null
  budgetDelta?: number | null
  decidedBy?: string | null
}

/**
 * 校验 + race-winner claim。
 *
 * - `claimed=true`  → 本端先到，`waiter` 含最终决策
 * - `claimed=false` → 另一端先到，`by` 指明谁先到了
 * - 抛 `ApprovalClaimError` → 校验失败，客户端 4xx
 */
export async function claimApproval(
  opts: ClaimApprovalOptions,
  deps: ApprovalClaimDeps,
): Promise<ClaimResult> {
  const waiter = await deps.getWaiterById(opts.waiterId)
  if (!waiter) {
    throw new ApprovalClaimError(
      'not_found',
      `waiter ${opts.waiterId} not found`,
    )
  }

  // 1. decision_set 校验
  const allowed =
    waiter.decisionSet === 'binary'
      ? BINARY_ALLOWED
      : waiter.decisionSet === 'plan_escalation'
        ? PLAN_ESCALATION_ALLOWED
        : ESCALATION_ALLOWED
  if (!allowed.has(opts.decision)) {
    const allowedList = Array.from(allowed).join(', ')
    throw new ApprovalClaimError(
      'decision_not_allowed',
      `decision '${opts.decision}' not allowed for decision_set='${waiter.decisionSet}' ` +
        `(allowed: ${allowedList})`,
    )
  }

  // 2. budget_extended → budgetDelta 校验
  if (opts.decision === 'budget_extended') {
    const d = opts.budgetDelta
    if (
      d == null ||
      !Number.isInteger(d) ||
      d < BUDGET_DELTA_MIN ||
      d > BUDGET_DELTA_MAX
    ) {
      throw new ApprovalClaimError(
        'budget_delta_invalid',
        `budget_delta must be integer in [${BUDGET_DELTA_MIN}, ${BUDGET_DELTA_MAX}] ` +
          `for decision='budget_extended', got: ${d}`,
      )
    }
  }

  // 3. 委托 DB race-claim
  return deps.claimWaiter(opts.waiterId, opts.source, {
    decision: opts.decision,
    rejectReason: opts.rejectReason ?? null,
    budgetDelta: opts.budgetDelta ?? null,
    decidedBy: opts.decidedBy ?? null,
  })
}

// =============================================================================
// 节点辅助函数（skill_with_approval 内部循环用）
// =============================================================================

/**
 * 当前 round（从 1 开始）是否已达到 budget 上限——需转入 ESCALATION 子流程而非直接 reject 回循环。
 *
 * @param round   当前 waiter 的 round（1-based）
 * @param budget  节点参数 budget（最多允许几轮 reject 后上报）
 */
export function shouldEscalate(round: number, budget: number): boolean {
  return round >= budget
}

/**
 * budget_extended 决策后计算新有效 budget。
 * delta 来自 waiter.budgetDelta（已由 claimApproval 校验过范围）。
 */
export function computeNewBudget(currentBudget: number, delta: number): number {
  return currentBudget + delta
}
