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

import { buildSpecApprovalSummary as _buildSpecApprovalSummary, type BuildSpecApprovalSummaryArgs as _SpecArgs } from './spec.js'
import { buildPlanApprovalSummary as _buildPlanApprovalSummary, type BuildPlanApprovalSummaryArgs as _PlanArgs } from './plan.js'
import { buildFinalApprovalSummary as _buildFinalApprovalSummary, type BuildFinalApprovalSummaryArgs as _FinalArgs } from './final.js'

/**
 * human_gate 节点的摘要拼装入口。按 kind 分派到对应 builder。
 * 调用方（buildHumanGateNode）从 stepOutputs / params 把 args 准备好，本函数只做转发。
 * kind='none' 时返回两个 null，让 caller 走 fallback 文案。
 */
export type BuildHumanGateSummaryInput =
  | { kind: 'spec'; args: _SpecArgs }
  | { kind: 'plan'; args: _PlanArgs }
  | { kind: 'final'; args: _FinalArgs }
  | { kind: 'none' }

export function buildHumanGateSummary(input: BuildHumanGateSummaryInput): {
  web: string | null
  im: string | null
} {
  switch (input.kind) {
    case 'spec':
      return _buildSpecApprovalSummary(input.args)
    case 'plan':
      return _buildPlanApprovalSummary(input.args)
    case 'final':
      return _buildFinalApprovalSummary(input.args)
    case 'none':
      return { web: null, im: null }
  }
}

/**
 * 从 human_gate 节点的 params 解析高保真审批摘要。
 * 调用方（buildHumanGateNode）注入 fileReader 读 spec.md / plan.md 等 artifact 文件。
 * 不识别 summaryKind 或缺关键 input 时返回 null，让 caller 走 fallback 文案。
 *
 * 当前仅实现 spec 路径；plan / final 留下一轮（args 形状差异较大，需单独适配）。
 */
export function resolveHumanGateAdvancedSummary(args: {
  params: Record<string, unknown>
  readFile: (path: string) => string
}): { web: string; im: string | null } | null {
  const { params, readFile } = args
  const summaryKind = typeof params.summaryKind === 'string' ? params.summaryKind : null
  if (summaryKind !== 'spec') return null

  // pipeline variable substitution（resolveVariables）会把 object 引用 stringify 成 JSON 字符串；
  // 这里兜底 parse，让 bootstrap.ts 的 '{{steps.spec_author.output.skillOutput}}' 模板能跑通。
  let skillOutput: unknown = params.skillOutput
  if (typeof skillOutput === 'string') {
    try {
      skillOutput = JSON.parse(skillOutput)
    } catch {
      return null
    }
  }
  if (skillOutput == null || typeof skillOutput !== 'object') return null

  const artifactPath = typeof params.artifactPath === 'string' ? params.artifactPath : ''
  const specMdContent = artifactPath ? readFile(artifactPath) : ''
  const round = Number(params.round ?? 1)

  // skillOutput cast: caller 通过模板插值得到的 plain object（zod schema 匹配 SpecAuthorOutput）
  const result = _buildSpecApprovalSummary({
    skillOutput: skillOutput as Parameters<typeof _buildSpecApprovalSummary>[0]['skillOutput'],
    specMdContent,
    round,
  })
  return result
}
