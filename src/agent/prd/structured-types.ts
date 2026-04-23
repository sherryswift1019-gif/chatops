/**
 * PRD Agent V2.0 — 结构化 PRD 入参类型定义。
 *
 * 对应迭代文档 docs/prds/prd-agent-v2-iteration.md §5.2。
 *
 * 设计原则：
 *   - 结构化只覆盖可被机械校验的字段（source、枚举、5W、验收数字等）
 *   - 叙事、推导、权衡、旅程全部作为自由文本字段（narrative / description / rationale）
 *   - Renderer 按"骨架（结构化）+ 肉（自由文本）"拼成 markdown，保留叙事感
 *
 * 本文件仅定义类型，不含运行时逻辑。机械校验函数在 mechanical-check.ts。
 */

export type PrdImpactType =
  | '行为变更'
  | '接口变更'
  | '数据结构变更'
  | 'UI 变更'
  | '行为复用'
  | '性能影响'
  | '无直接影响'

export type PrdImpactCompatibility = '完全兼容' | '向后兼容' | '破坏性变更'

export type PrdPriority = 'P0' | 'P1' | 'P2'

export type PrdRequirementSourceType =
  | 'user_said'        // 用户在对话中明确说过
  | 'agent_inferred'   // Agent 推断（需显式标注）
  | 'codebase_fact'    // 从代码/资产检索得到的事实

export interface PrdRequirementSource {
  /** Phase 编号（1-4）或对话轮次索引 */
  phase: number
  /** 用户原话或检索到的原文片段 */
  quote: string
  type: PrdRequirementSourceType
}

export interface PrdMeta {
  title: string
  productLineId: number
  pmName?: string
}

export interface PrdSuccessMetric {
  metric: string
  /** 目标值（可带单位，如 "P99 < 500ms" / "≥ 85%"） */
  target: string
  /** 度量方式（如 "SLO 看板" / "周度抽样 50 条人工评估"） */
  measurement: string
}

export interface PrdGoals {
  /** 愿景（自由文本：PM 原话 / 叙事） */
  vision: string
  /** 一句话定位，15 字内，Phase 1 就确定，不依赖 LLM 后续总结 */
  oneLineStatement: string
  /** 3-5 条项目目标 */
  objectives: string[]
  successMetrics: PrdSuccessMetric[]
}

export interface PrdUserJourneyStep {
  order: number
  action: string
}

export interface PrdUserJourney {
  id: string
  name: string
  persona: string
  steps: PrdUserJourneyStep[]
}

export interface PrdUsers {
  /** 主要用户群 */
  primarySegment: string
  /** 自由文本：用户场景 / 旅程叙事 */
  narrative?: string
  journeys?: PrdUserJourney[]
}

/**
 * 5W 动作闭环。有 actions 的功能需求，每个 action 必须填齐 5 个字段，
 * 机械校验由 closed_loop 规则执行（见 rules.ts）。
 */
export interface PrdAction {
  /** 动作动词，如 "驳回"、"提交审批"、"撤回" */
  verb: string
  /** 谁 / 什么情况 触发此动作 */
  trigger: string
  /** 动作执行后系统/数据状态如何变化 */
  stateChange: string
  /** 通知谁、怎么通知 */
  notify: string
  /** 之后该谁接力，做什么 */
  nextActor: string
  /** 终态是什么（闭环） */
  terminalState: string
}

export interface PrdAcceptanceCriterion {
  /** 验收项原文。机械校验要求必含数字或字段名（measurable_acceptance 规则）。 */
  text: string
}

export interface PrdFunctionalRequirement {
  /** 章节编号，如 "3.1" / "3.2.1" */
  id: string
  name: string
  priority: PrdPriority
  /** 自由文本：设计描述 / 推导 / 权衡 */
  description: string
  /** 强制：来源追溯（source_traceable 机械校验） */
  source: PrdRequirementSource
  acceptanceCriteria: PrdAcceptanceCriterion[]
  /** 可选；一旦提供，每个 action 必须完整 5W（closed_loop 机械校验） */
  actions?: PrdAction[]
}

export interface PrdImpactItem {
  module: string
  type: PrdImpactType
  compatibility: PrdImpactCompatibility
  description: string
  /** 来源（与 FunctionalRequirement.source 同构的最小形态） */
  source: string
}

/**
 * 破坏性变更详述。impacts 中出现任一 compatibility='破坏性变更' 时，
 * breakingChanges 必须有对应条目（breaking_change_detail 机械校验）。
 */
export interface PrdBreakingChange {
  /** 关联的 module 名（与 impacts[*].module 对齐） */
  module?: string
  /** 现状描述 */
  current: string
  /** 变更后描述 */
  after: string
  /** 受影响方（"调用方 A"、"前端 FE"、"运营后台"等） */
  affectedParties: string[]
  /** 迁移步骤 */
  migrationSteps: string
  /** 回滚策略 */
  rollbackStrategy: string
}

export interface PrdScopeOutItem {
  item: string
  reason: string
}

export interface PrdScopeTbdItem {
  item: string
  /** 待谁拍板 / 待什么信息到位 */
  needsInput?: string
}

export interface PrdScope {
  inScope: string[]
  outOfScope: PrdScopeOutItem[]
  tbd: PrdScopeTbdItem[]
}

export interface PrdDecision {
  decision: string
  /** 自由文本：决策理由 */
  rationale: string
  alternatives?: string[]
  /** ISO 日期字符串 */
  decidedAt: string
}

/**
 * V2.0 save_prd 结构化入参。
 *
 * Markdown 不由 Agent 输出，而是由 renderer.ts 按模板从此结构生成。
 * V1 的 contentMarkdown 签名仍保留（见 iteration doc §5.1 双签名并存）。
 */
export interface StructuredPrd {
  meta: PrdMeta
  goals: PrdGoals
  users: PrdUsers
  functionalRequirements: PrdFunctionalRequirement[]
  impacts: PrdImpactItem[]
  /** impacts 中出现破坏性变更则必填（机械校验拦截） */
  breakingChanges: PrdBreakingChange[]
  scope: PrdScope
  decisionLog?: PrdDecision[]
  /** 全局自由文本，保留 PM 叙事（可空） */
  narrative?: string
}

/**
 * 机械校验失败项。save_prd 入口会把所有规则的 MechanicalError[] 聚合返回给 Agent。
 */
export interface MechanicalError {
  /** 对应 rules.ts 中的规则 id，如 "closed_loop" / "source_traceable" */
  ruleId: string
  /** 错误定位，建议使用点路径表达，如 "functionalRequirements[3.1].acceptanceCriteria[0]" */
  field: string
  /** 人类可读错误消息，Agent 将据此修正后 retry save_prd */
  message: string
}
