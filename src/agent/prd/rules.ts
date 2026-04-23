/**
 * PRD Agent V2.0 — 规则注册中心（单一事实源）。
 *
 * 对应迭代文档 docs/prds/prd-agent-v2-iteration.md §4。
 *
 * 核心收益：
 *   改这一条规则的 generatorInstruction / reviewerCheck，
 *   CREATE prompt 和 REVIEW prompt 两处通过 render 函数自动同步，
 *   彻底消除 V1 两份 prompt 飘移的问题。
 *
 * 机械校验（mechanicalCheck）函数留在 mechanical-check.ts 实现，
 * 本文件只做规则声明与文本渲染。
 */

import type { MechanicalError, StructuredPrd } from './structured-types.js'

// =============================================================================
// 规则元类型
// =============================================================================

export type PrdRuleDimension =
  | 'format'          // 格式完整性
  | 'traceability'    // 来源追溯
  | 'measurable'      // 可度量性
  | 'impact'          // 影响范围
  | 'consistency'     // 一致性（范围 / 矛盾）
  | 'closed_loop'     // 5W 闭环（V2 新增维度）

export type PrdRulePhase =
  | 'discovery'       // Phase 1 项目发现
  | 'features'        // Phase 2 核心功能
  | 'scope'           // Phase 3 范围确认
  | 'draft'           // Phase 4 生成 PRD

export type PrdRuleSeverity = 'blocker' | 'warning' | 'info'

export type PrdRuleOwner = 'product' | 'tech' | 'both'

export interface PrdRule {
  /** 规则唯一 id，短蛇形，review findings 以此为主键 */
  id: string
  dimension: PrdRuleDimension
  severity: PrdRuleSeverity
  /** 违反此规则时是否可由 repair Agent 自动修复 */
  autoFix: boolean

  // ---- 同一条规则的三种形态（单一事实源核心）----
  /** Phase 2 对话追问模板（可空：非所有规则都适合在对话中主动问） */
  dialogueProbe?: string
  /** Phase 4 生成约束（写进 CREATE_PRD_SYSTEM_PROMPT） */
  generatorInstruction: string
  /** 审查检查项（写进 REVIEW_PRD_SYSTEM_PROMPT） */
  reviewerCheck: string
  /**
   * 修复提示（写进 REPAIR_PRD_SYSTEM_PROMPT）。
   * 短句，告诉 repair Agent 违反此规则时如何最小化修复（≤ 1 行）。
   * 空值则 cheat sheet 不列出此规则。
   */
  repairHint?: string

  applicablePhases: PrdRulePhase[]

  /**
   * 机械校验函数（可选）。
   * 定义了此字段的规则会在 save_prd 入口被执行，零 LLM 开销拦截。
   * 返回空数组表示通过，返回非空数组表示违规项。
   * 实现位于 mechanical-check.ts；此文件只声明引用。
   */
  mechanicalCheck?: (prd: StructuredPrd) => MechanicalError[]

  // ---- 治理元信息 ----
  /** ISO 日期 YYYY-MM-DD */
  createdAt: string
  owner: PrdRuleOwner
}

// =============================================================================
// 初版规则清单（V2.0 MVP 10 条）
// =============================================================================
//
// 规则编写原则：
//   - generatorInstruction：命令式，告诉 Agent "必须做什么"
//   - reviewerCheck：疑问式，告诉审查者 "要确认什么"
//   - dialogueProbe：Agent 在 Phase 2 主动问 PM 的模板（可空）
//   - 每条规则的三种形态描述的是同一事实的不同视角，语义必须对齐
//
// mechanicalCheck 字段先留空（标注 TODO），由后续切片接入 mechanical-check.ts。
// =============================================================================

export const PRD_RULES: PrdRule[] = [
  // -------- 1. format --------
  {
    id: 'chapter_complete',
    dimension: 'format',
    severity: 'blocker',
    autoFix: false,
    generatorInstruction:
      'PRD 必须包含全部 9 个章节且顺序不可调整：愿景与目标 / 用户与场景 / 功能需求 / 非功能需求 / 与现有系统集成 / 对现有功能的影响 / 范围边界 / 待定事项 / 决策日志。第 6 章「对现有功能的影响」不是可选章节，即便是全新模块也必须列出耦合的现有模块（auth / 权限 / 数据库 / UI 等）。',
    reviewerCheck:
      '确认 PRD 包含全部 9 个必需章节，且顺序正确。每个功能需求是否含 描述 / 验收标准 / 来源 三个子字段？第 6 章至少含 6.1 受影响清单子表格？',
    repairHint:
      '补齐缺失章节并按正确顺序排列；全新模块的第 6 章也至少写一条 `{ type: "无直接影响" }`。',
    applicablePhases: ['draft'],
    createdAt: '2026-04-22',
    owner: 'tech',
  },
  {
    id: 'no_impl_leak',
    dimension: 'format',
    severity: 'warning',
    autoFix: true,
    generatorInstruction:
      'PRD 聚焦 What/Why，不应包含 How（技术实现细节）。禁止出现 "用 Redis 缓存" / "React 组件" / "MySQL 索引" / "调用 XX 微服务" 等实现选型。例外：第 5 章「与现有系统集成」和第 6 章「对现有功能的影响」可以提到现有模块名（如 "复用现有 auth 模块"），但不涉及新模块的实现选型。',
    reviewerCheck:
      '检查是否出现技术实现细节（Redis / React / MySQL / 微服务名等）。第 5、6 章提到现有模块名属允许范围；其他章节出现即为实现泄漏。',
    repairHint:
      '移除 PRD 正文中的技术选型词（Redis/React/MySQL 等）；仅第 5、6 章允许提到现有模块名。',
    applicablePhases: ['draft'],
    createdAt: '2026-04-22',
    owner: 'tech',
  },

  // -------- 2. traceability --------
  {
    id: 'source_traceable',
    dimension: 'traceability',
    severity: 'blocker',
    autoFix: false,
    dialogueProbe:
      '你刚才说的这个需求来源我帮你标一下：是 Phase {{phase}} 里"{{quote}}"这句话吗？还是有别的依据？',
    generatorInstruction:
      '每条功能需求必须有 source 字段（phase / quote / type），来源为以下之一：用户在对话中明确说过（user_said）/ 检索资产（codebase_fact）/ Agent 推断且用户确认（agent_inferred）。第 6.1 受影响清单每条也需 source 字段，不允许"用户需要"之类笼统表述。',
    reviewerCheck:
      '确认每条功能需求、每条受影响条目都有具体 source（指向对话轮次或检索资产）。"用户需要" / "业务要求" 这种笼统表述不算有效 source。',
    repairHint:
      '在功能需求末尾补 `**来源:** Phase X — "用户原话"（user_said/agent_inferred/codebase_fact 之一）`。',
    applicablePhases: ['features', 'draft'],
    createdAt: '2026-04-22',
    owner: 'product',
  },

  // -------- 3. measurable --------
  {
    id: 'measurable_acceptance',
    dimension: 'measurable',
    severity: 'blocker',
    autoFix: false,
    dialogueProbe:
      '这个验收标准我想确认一下可度量口径：具体到什么数字 / 什么字段 / 什么状态？比如 "P99 < 500ms" 或 "status 字段 = approved"，而不是 "快速" / "友好"。',
    generatorInstruction:
      '每条验收标准必须含"数字"或"可枚举的字段/状态"之一。不接受 "快速" / "友好" / "流畅" / "好用" / "提升体验" 这类无度量口径的表述。非功能指标必须含具体数字和度量方式（如 P99 < 500ms、SLO 看板）。',
    reviewerCheck:
      '验收标准是否具体可测？避免 "快速/友好/高效" 等模糊词。非功能指标是否有具体数字（P99/QPS/SLO）且度量方式明确？',
    repairHint:
      '把模糊验收改为含数字或字段名（如 "P99 < 500ms"、"order.status = paid"），不新增验收条目。',
    applicablePhases: ['features', 'draft'],
    createdAt: '2026-04-22',
    owner: 'product',
  },
  {
    id: 'no_soft_language',
    dimension: 'measurable',
    severity: 'warning',
    autoFix: true,
    generatorInstruction:
      'PRD 正文禁止使用 "为了提升用户体验" / "打造完美产品" / "业界领先" 等无信息量的修饰语。每句话删掉后不损失信息 = 废话。',
    reviewerCheck:
      '检查是否有口水话、废话、重复表述。"为了提升用户体验""打造完美产品"等无信息量句子全部标 warning。',
    repairHint:
      '删除"提升体验""打造完美""业界领先"等无信息量修饰语，原段落不重写。',
    applicablePhases: ['draft'],
    createdAt: '2026-04-22',
    owner: 'tech',
  },

  // -------- 4. impact --------
  {
    id: 'impact_enum',
    dimension: 'impact',
    severity: 'blocker',
    autoFix: true,
    generatorInstruction:
      '第 6.1 受影响清单的「影响类型」字段只允许以下枚举值：行为变更 / 接口变更 / 数据结构变更 / UI 变更 / 行为复用 / 性能影响 / 无直接影响。「兼容性」字段只允许：完全兼容 / 向后兼容 / 破坏性变更。严禁 "可能变化" / "大概会改动" 等模糊描述。',
    reviewerCheck:
      '检查 6.1 表格的「影响类型」是否全部命中枚举词？「兼容性」是否全部命中枚举词？是否有"可能影响""大概会改动"等模糊描述（= blocker）？',
    repairHint:
      '影响类型只用 7 个枚举词之一；兼容性只用 3 个枚举词之一。禁止"可能/大概"。',
    applicablePhases: ['scope', 'draft'],
    createdAt: '2026-04-22',
    owner: 'tech',
  },
  {
    id: 'breaking_change_detail',
    dimension: 'impact',
    severity: 'blocker',
    autoFix: false,
    dialogueProbe:
      '这个改动是破坏性变更。我需要你明确以下四项才能写进 PRD：现状是什么？变更后长什么样？影响哪些调用方？迁移步骤和回滚策略？',
    generatorInstruction:
      '6.1 中每条 compatibility="破坏性变更" 的条目，在 6.2 必须有对应详述（现状 / 变更后 / 影响方 / 迁移步骤 / 回滚策略），五项字段缺一不可。',
    reviewerCheck:
      '6.1 的破坏性变更条目在 6.2 是否全部有对应详述？现状 / 变更后 / 影响方 / 迁移步骤 / 回滚策略，五项任一缺失 = blocker。',
    repairHint:
      '在 6.2 为每条破坏性变更补齐五字段：现状 / 变更后 / 影响方 / 迁移步骤 / 回滚策略。',
    applicablePhases: ['scope', 'draft'],
    createdAt: '2026-04-22',
    owner: 'product',
  },

  // -------- 5. consistency --------
  {
    id: 'scope_consistent',
    dimension: 'consistency',
    severity: 'blocker',
    autoFix: true,
    generatorInstruction:
      '"明确排除"列表中的条目不得同时出现在功能需求中。"待定事项"中的条目不得被当作已确认需求写进 PRD 的功能需求章节。',
    reviewerCheck:
      '对比第 7 章「明确排除」条目与第 3 章功能需求，是否有重叠？对比第 8 章「待定事项」条目，是否有条目被当作已确认需求写入了第 3 章？',
    repairHint:
      '把与第 7 章「明确排除」或第 8 章「待定事项」冲突的第 3 章功能条目删除或移至对应章节。',
    applicablePhases: ['scope', 'draft'],
    createdAt: '2026-04-22',
    owner: 'product',
  },
  {
    id: 'no_contradiction',
    dimension: 'consistency',
    severity: 'blocker',
    autoFix: false,
    generatorInstruction:
      '章节之间的陈述不得互相矛盾：愿景中的目标用户与第 2 章用户群应一致；功能需求与非功能需求不得冲突；第 6 章受影响模块应与第 5 章集成模块列表逻辑自洽。',
    reviewerCheck:
      '检查章节之间是否存在事实矛盾：愿景说"面向外部客户"但用户章节列"内部员工"？功能需求与非功能需求互斥？第 5 章集成模块与第 6 章受影响模块是否逻辑自洽？',
    repairHint:
      '矛盾点无法自动决定孰是孰非，保留占位符 `[TBD - <ruleId=no_contradiction 的 issue 简述>]` 并在决策日志注明"待补充"。',
    applicablePhases: ['draft'],
    createdAt: '2026-04-22',
    owner: 'both',
  },

  // -------- 6. closed_loop (V2 新增) --------
  {
    id: 'closed_loop',
    dimension: 'closed_loop',
    severity: 'blocker',
    autoFix: false,
    dialogueProbe:
      '你刚才说的"{{verb}}"动作我需要闭环地确认一下：谁会触发（trigger）？按下后系统状态怎么变（stateChange）？通知谁（notify）？之后交给谁接力（nextActor）？最终停在什么终态（terminalState）？',
    generatorInstruction:
      '凡功能需求中出现动作（按钮 / 操作 / 状态流转），必须以 action 形式描述 5W 闭环：trigger（谁触发）/ stateChange（状态如何变）/ notify（通知谁）/ nextActor（之后谁接力）/ terminalState（终态是什么）。任一字段缺失即为不闭环。典型反例："定义了驳回按钮，但点了之后做什么没写"。',
    reviewerCheck:
      '检查功能需求中凡提到"按钮/操作/状态流转"的动作，是否在 action 中填齐 5W：trigger / stateChange / notify / nextActor / terminalState？有动作描述但 5W 不全 = blocker。',
    repairHint:
      '动作按钮必须补齐 5W：触发 / 状态变化 / 通知 / 下一接力人 / 终态；若事实不足则留占位符且标 TBD。',
    applicablePhases: ['features', 'scope', 'draft'],
    createdAt: '2026-04-22',
    owner: 'product',
  },
]

// =============================================================================
// 规则一致性自检（模块加载时执行）
// =============================================================================

function assertRulesShapeValid(): void {
  const ids = new Set<string>()
  for (const r of PRD_RULES) {
    if (ids.has(r.id)) {
      throw new Error(`[rules.ts] 规则 id 重复：${r.id}`)
    }
    ids.add(r.id)
    if (!r.generatorInstruction || !r.reviewerCheck) {
      throw new Error(`[rules.ts] 规则 ${r.id} 缺少 generatorInstruction 或 reviewerCheck`)
    }
    if (r.applicablePhases.length === 0) {
      throw new Error(`[rules.ts] 规则 ${r.id} 的 applicablePhases 为空`)
    }
  }
}

assertRulesShapeValid()

// =============================================================================
// Prompt 渲染函数（三处消费点）
// =============================================================================

/**
 * Phase 2 / 3 对话追问模板渲染。
 * 只取 applicablePhases 命中且有 dialogueProbe 的规则。
 * 返回纯文本片段，由 CREATE_PRD_SYSTEM_PROMPT 在对应阶段段落嵌入。
 */
export function renderDialogueProbes(phase: PrdRulePhase): string {
  const probes = PRD_RULES
    .filter((r) => r.applicablePhases.includes(phase) && r.dialogueProbe)
    .map((r) => `- [${r.id}] ${r.dialogueProbe}`)
  if (probes.length === 0) return ''
  return probes.join('\n')
}

/**
 * Phase 4 生成约束渲染。
 * 写进 CREATE_PRD_SYSTEM_PROMPT 的生成段落。
 * 按 severity 排序（blocker 在前），让 Agent 优先关注必须满足的规则。
 */
export function renderGeneratorInstructions(): string {
  const severityOrder: Record<PrdRuleSeverity, number> = {
    blocker: 0,
    warning: 1,
    info: 2,
  }
  const sorted = [...PRD_RULES].sort(
    (a, b) => severityOrder[a.severity] - severityOrder[b.severity]
  )
  return sorted
    .map(
      (r) =>
        `- [${r.id}] (${r.severity}) ${r.generatorInstruction}`
    )
    .join('\n')
}

/**
 * 审查检查项渲染。
 * 写进 REVIEW_PRD_SYSTEM_PROMPT 的 checks 段落，替代原硬编码 9 维清单。
 * 输出每条含 ruleId，确保审查 finding 能以 ruleId 回查规则。
 */
export function renderReviewerChecks(): string {
  const severityOrder: Record<PrdRuleSeverity, number> = {
    blocker: 0,
    warning: 1,
    info: 2,
  }
  const sorted = [...PRD_RULES].sort(
    (a, b) => severityOrder[a.severity] - severityOrder[b.severity]
  )
  return sorted
    .map(
      (r) =>
        `- [${r.id}] (severity=${r.severity}, dimension=${r.dimension}) ${r.reviewerCheck}`
    )
    .join('\n')
}

/**
 * 按 id 查询规则。Repair agent 根据 finding.ruleId 反查 generatorInstruction
 * 时使用。未找到返回 undefined。
 */
export function findRuleById(id: string): PrdRule | undefined {
  return PRD_RULES.find((r) => r.id === id)
}

/**
 * Repair prompt cheat sheet 渲染。
 * 写进 REPAIR_PRD_SYSTEM_PROMPT 的反查段落，给修复 Agent 一张按 ruleId 对齐的
 * 最小化修复建议表。只列出显式声明了 repairHint 的规则。
 *
 * 输出格式：`- \`ruleId\`: repairHint`
 *
 * 与 renderReviewerChecks 一样按 severity 排序（blocker 在前），让 Agent 先处理硬拦截项。
 */
export function renderRepairCheatSheet(): string {
  const severityOrder: Record<PrdRuleSeverity, number> = {
    blocker: 0,
    warning: 1,
    info: 2,
  }
  return [...PRD_RULES]
    .filter((r) => r.repairHint)
    .sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity])
    .map((r) => `- \`${r.id}\`: ${r.repairHint}`)
    .join('\n')
}

/**
 * 当前规则集的版本 tag。每次规则变更需同步 bump，并在 save_prd 时写入
 * `content_json.rulesVersion`，保证旧 PRD 锁在创建时的规则版本。
 */
export const RULES_VERSION = 'rules-v1' as const
