/**
 * StructuredArch — 架构设计 Agent 的结构化产出类型（V1）
 *
 * 对应架构文档 13 章节：
 *  1. 概述  2. 高层架构  3. 技术选型  4. 数据模型  5. 组件设计
 *  6. 核心工作流  7. API 规范  8. 基础设施  9. 安全  10. 错误处理
 *  11. NFR  12. ADR  13. 实现就绪检查表
 */

// ─── 技术选型 ───────────────────────────────────────────────────────────────

export interface TechStackItem {
  /** 技术层次，如 "数据库" / "Web 框架" / "消息队列" */
  layer: string
  /** 选型名称 + 版本，如 "PostgreSQL 16" */
  choice: string
  /** 对比过的替代方案 */
  alternatives: string[]
  /** 选择理由（来源于用户确认的 ADR） */
  rationale: string
  /** 谁批准的：用户对话轮次摘要或"Phase 2 round N" */
  approvedBy: string
}

// ─── 数据模型 ───────────────────────────────────────────────────────────────

export interface DataField {
  name: string
  type: string
  nullable: boolean
  description?: string
}

export interface DataModelEntity {
  name: string
  description: string
  fields: DataField[]
  /** Mermaid erDiagram 片段（可选） */
  erDiagram?: string
  /** 关键索引描述 */
  indexes?: string[]
}

// ─── 组件设计 ───────────────────────────────────────────────────────────────

export interface ComponentItem {
  name: string
  responsibility: string
  /** 对外暴露的关键接口描述 */
  keyInterfaces: string[]
  techChoice?: string
}

// ─── 核心工作流 ─────────────────────────────────────────────────────────────

export type WorkflowPriority = 'P0' | 'P1' | 'P2'

export interface WorkflowItem {
  id: string           // 如 "6.1"
  name: string
  priority: WorkflowPriority
  /** Mermaid sequenceDiagram 源码（P0 必填） */
  sequenceDiagram: string
  description?: string
}

// ─── API 规范 ───────────────────────────────────────────────────────────────

export interface ApiEndpoint {
  method: string
  path: string
  description: string
  requestBody?: string
  responseBody?: string
}

// ─── NFR ────────────────────────────────────────────────────────────────────

export interface NfrItem {
  category: string   // "性能" | "可扩展性" | "可观测性" | "可靠性" | ...
  requirement: string
  target?: string
}

// ─── ADR ────────────────────────────────────────────────────────────────────

export type AdrStatus = 'Proposed' | 'Accepted' | 'Deprecated' | 'Superseded'

export interface AdrItem {
  id: string           // 如 "ADR-001"
  title: string
  status: AdrStatus
  context: string      // 背景与问题
  options: string[]    // 对比的选项
  decision: string     // 最终决策
  consequences?: string
  /** 来源：对话 Phase + round，或 PRD section */
  source: string
}

// ─── 范围边界 ────────────────────────────────────────────────────────────────

export interface ArchScope {
  inScope: string[]
  outOfScope: string[]
  tbd: string[]
}

// ─── 顶层 StructuredArch ─────────────────────────────────────────────────────

export interface StructuredArch {
  meta: {
    title: string
    productLineId: number
    /** 可选关联 PRD ID */
    sourcePrdId?: number
    architectName?: string
    version?: string
  }
  overview: {
    /** 一句话架构定位 */
    positioning: string
    /** 架构风格：微服务 / 单体 / 事件驱动 / 无服务器 / ... */
    style: string
    /** 3-5 条核心设计原则 */
    principles: string[]
    /** Mermaid graph/flowchart 源码（必填） */
    componentDiagram: string
  }
  /** 技术选型列表，每项含 approvedBy（必填） */
  techStack: TechStackItem[]
  dataModels: DataModelEntity[]
  components: ComponentItem[]
  /** 核心工作流，P0 级别必须含 sequenceDiagram（至少 2 个必填） */
  coreWorkflows: WorkflowItem[]
  apiSpec?: ApiEndpoint[]
  /** 基础设施与部署描述（自由文本） */
  infrastructure?: string
  /** 安全架构描述（自由文本） */
  security?: string
  /** 错误处理与容错策略（自由文本） */
  errorHandling?: string
  nfrs?: NfrItem[]
  /** 架构决策记录（必填） */
  adrs: AdrItem[]
  /** 实现就绪检查表，checkbox 条目（必填） */
  readinessChecklist: string[]
  scope: ArchScope
}
