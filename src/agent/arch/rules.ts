/**
 * 架构设计 Agent 规则集（V1）
 *
 * 与 PRD rules.ts 同构：Rules as Single Source of Truth。
 * 每条规则同时定义：
 *  - mechanicalCheck：Phase 5 save_arch 时的机械校验
 *  - dialogueProbe：Phase 3-4 Agent 应追问的问题模板
 *  - generatorInstruction：注入 CREATE_ARCH_SYSTEM_PROMPT 的生成约束
 *
 * V1 所有规则 autoFix = false（架构文档的 blocker 是信息缺失，
 * 不是格式问题，AI 修复会引入幻觉）。
 */

import type { StructuredArch } from './structured-types.js'

export type ArchRuleDimension =
  | 'format'
  | 'traceability'
  | 'consistency'
  | 'completeness'

export type ArchRuleSeverity = 'blocker' | 'warning' | 'info'

export interface ArchMechanicalError {
  ruleId: string
  severity: ArchRuleSeverity
  message: string
  path?: string
}

export interface ArchRule {
  id: string
  dimension: ArchRuleDimension
  severity: ArchRuleSeverity
  autoFix: false
  description: string
  /** Phase 3-4 追问模板 */
  dialogueProbe?: string
  /** 注入 CREATE_ARCH_SYSTEM_PROMPT 的约束文本 */
  generatorInstruction: string
  /** 机械校验实现（返回空数组表示通过） */
  mechanicalCheck?: (arch: StructuredArch) => ArchMechanicalError[]
}

// ─────────────────────────────────────────────────────────────────────────────

export const ARCH_RULES: ArchRule[] = [
  // ── 格式完整性 ─────────────────────────────────────────────────────────────

  {
    id: 'chapter_complete',
    dimension: 'format',
    severity: 'blocker',
    autoFix: false,
    description: '必填章节不得为空',
    generatorInstruction:
      'overview / techStack / dataModels / components / coreWorkflows / adrs / readinessChecklist / scope 均为必填字段，不得省略或留空数组。',
    mechanicalCheck(arch) {
      const errors: ArchMechanicalError[] = []
      const required: Array<[keyof StructuredArch, string]> = [
        ['techStack', 'techStack（技术选型）'],
        ['dataModels', 'dataModels（数据模型）'],
        ['components', 'components（组件设计）'],
        ['coreWorkflows', 'coreWorkflows（核心工作流）'],
        ['adrs', 'adrs（架构决策记录）'],
        ['readinessChecklist', 'readinessChecklist（实现就绪检查表）'],
      ]
      for (const [key, label] of required) {
        const val = arch[key]
        if (!val || (Array.isArray(val) && val.length === 0)) {
          errors.push({
            ruleId: 'chapter_complete',
            severity: 'blocker',
            message: `${label} 为空，必须填写`,
            path: key,
          })
        }
      }
      if (!arch.scope.inScope.length) {
        errors.push({
          ruleId: 'chapter_complete',
          severity: 'blocker',
          message: 'scope.inScope 为空',
          path: 'scope.inScope',
        })
      }
      return errors
    },
  },

  {
    id: 'component_diagram',
    dimension: 'format',
    severity: 'blocker',
    autoFix: false,
    description: '高层架构必须包含 Mermaid 组件图',
    dialogueProbe:
      '高层组件图还没有 Mermaid 源码，请描述各组件及其关系，我来帮你生成 sequenceDiagram 或 graph。',
    generatorInstruction:
      'overview.componentDiagram 必须包含有效的 Mermaid graph/flowchart 源码，不得为空字符串。',
    mechanicalCheck(arch) {
      if (!arch.overview.componentDiagram?.trim()) {
        return [{
          ruleId: 'component_diagram',
          severity: 'blocker',
          message: 'overview.componentDiagram 为空，必须提供 Mermaid 组件图',
          path: 'overview.componentDiagram',
        }]
      }
      return []
    },
  },

  {
    id: 'sequence_diagrams',
    dimension: 'format',
    severity: 'blocker',
    autoFix: false,
    description: '核心工作流中 P0 级别必须含 Mermaid 时序图，且至少 2 个工作流有时序图',
    dialogueProbe:
      '还有 P0 核心流程没有时序图，请描述该流程的参与者和步骤（含重试/错误路径），我来帮你写 Mermaid sequenceDiagram。',
    generatorInstruction:
      'coreWorkflows 中每个 priority=P0 的工作流 sequenceDiagram 不得为空；整体至少 2 个工作流含 sequenceDiagram。',
    mechanicalCheck(arch) {
      const errors: ArchMechanicalError[] = []
      const p0Without = arch.coreWorkflows.filter(
        w => w.priority === 'P0' && !w.sequenceDiagram?.trim()
      )
      for (const w of p0Without) {
        errors.push({
          ruleId: 'sequence_diagrams',
          severity: 'blocker',
          message: `工作流 "${w.name}"（${w.id}）优先级为 P0 但缺少 sequenceDiagram`,
          path: `coreWorkflows[${w.id}].sequenceDiagram`,
        })
      }
      const withDiagram = arch.coreWorkflows.filter(w => w.sequenceDiagram?.trim())
      if (withDiagram.length < 2) {
        errors.push({
          ruleId: 'sequence_diagrams',
          severity: 'blocker',
          message: `含时序图的工作流不足 2 个（当前 ${withDiagram.length} 个）`,
          path: 'coreWorkflows',
        })
      }
      return errors
    },
  },

  // ── 技术选型合规 ──────────────────────────────────────────────────────────

  {
    id: 'tech_stack_approved',
    dimension: 'consistency',
    severity: 'blocker',
    autoFix: false,
    description: '技术选型每项必须含用户批准来源',
    dialogueProbe:
      '有几个技术选型还没有记录用户批准来源，请确认每项选型的批准依据（对话轮次或 PRD 章节）。',
    generatorInstruction:
      'techStack 中每个 TechStackItem 的 approvedBy 字段不得为空字符串，必须填写用户批准来源（如 "Phase 2 round 3 用户确认" 或 "PRD §3.2"）。',
    mechanicalCheck(arch) {
      const errors: ArchMechanicalError[] = []
      arch.techStack.forEach((item, i) => {
        if (!item.approvedBy?.trim()) {
          errors.push({
            ruleId: 'tech_stack_approved',
            severity: 'blocker',
            message: `技术选型 "${item.layer}: ${item.choice}" 缺少 approvedBy（用户批准来源）`,
            path: `techStack[${i}].approvedBy`,
          })
        }
      })
      return errors
    },
  },

  // ── 可追溯性 ──────────────────────────────────────────────────────────────

  {
    id: 'adr_for_each_tech',
    dimension: 'traceability',
    severity: 'warning',
    autoFix: false,
    description: '每个技术选型建议有对应的 ADR 条目',
    generatorInstruction:
      '对于每个重大技术选型，adrs 中应有对应的 ADR 条目记录决策背景和选项对比。',
    mechanicalCheck(arch) {
      if (arch.techStack.length > 0 && arch.adrs.length === 0) {
        return [{
          ruleId: 'adr_for_each_tech',
          severity: 'warning',
          message: '有技术选型但 ADR 列表为空，建议为重大选型补充 ADR',
          path: 'adrs',
        }]
      }
      return []
    },
  },

  {
    id: 'adr_source_traceable',
    dimension: 'traceability',
    severity: 'blocker',
    autoFix: false,
    description: 'ADR 每条决策必须有来源',
    generatorInstruction:
      'adrs 中每个 AdrItem 的 source 字段不得为空，必须注明来源（如 "Phase 2 用户确认" 或 "PRD §2.1"）。',
    mechanicalCheck(arch) {
      const errors: ArchMechanicalError[] = []
      arch.adrs.forEach((adr, i) => {
        if (!adr.source?.trim()) {
          errors.push({
            ruleId: 'adr_source_traceable',
            severity: 'blocker',
            message: `ADR "${adr.id}: ${adr.title}" 缺少 source（来源）`,
            path: `adrs[${i}].source`,
          })
        }
      })
      return errors
    },
  },

  // ── 实现就绪 ──────────────────────────────────────────────────────────────

  {
    id: 'readiness_checklist',
    dimension: 'completeness',
    severity: 'blocker',
    autoFix: false,
    description: '实现就绪检查表不得为空',
    dialogueProbe:
      '实现就绪检查表还没有条目，请确认：技术选型是否锁定？关键接口是否定义？DB migration 策略是否明确？安全边界是否标注？',
    generatorInstruction:
      'readinessChecklist 必须包含至少 5 个 checkbox 条目，覆盖：技术选型锁定、关键接口定义、DB schema 确认、安全边界标注、测试策略。',
    mechanicalCheck(arch) {
      if (!arch.readinessChecklist || arch.readinessChecklist.length < 3) {
        return [{
          ruleId: 'readiness_checklist',
          severity: 'blocker',
          message: `实现就绪检查表条目不足（当前 ${arch.readinessChecklist?.length ?? 0} 条，至少需要 3 条）`,
          path: 'readinessChecklist',
        }]
      }
      return []
    },
  },

  // ── 内容规范 ──────────────────────────────────────────────────────────────

  {
    id: 'no_impl_detail',
    dimension: 'consistency',
    severity: 'warning',
    autoFix: false,
    description: '架构文档描述"是什么"，不写实现代码',
    generatorInstruction:
      '架构文档描述系统的"是什么"（组件、接口、数据流、决策），不写代码实现细节（具体函数实现、SQL 查询体、算法伪代码）。',
  },
]

// ─── 渲染函数（注入 system prompt）────────────────────────────────────────────

export function renderGeneratorInstructions(): string {
  const lines = ARCH_RULES
    .filter(r => r.severity === 'blocker')
    .map(r => `- [${r.id}] ${r.generatorInstruction}`)
  return `\n\n【生成约束（来自规则引擎 V1）】\n${lines.join('\n')}`
}

export function renderDialogueProbes(): string {
  const lines = ARCH_RULES
    .filter(r => r.dialogueProbe)
    .map(r => `- [${r.id}] ${r.dialogueProbe}`)
  return lines.join('\n')
}
