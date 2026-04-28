import type { Node, Edge } from '@xyflow/react'

export type StageType =
  // phase 0 / pre-phase 3 五种 bespoke 节点（NodeInspector 有专属 UI）
  | 'script'
  | 'approval'
  | 'llm_agent'
  | 'wait_webhook'
  | 'im_input'
  // phase 3 新增 7 种（NodeInspector 走 JSON Schema 驱动的动态参数表单）
  | 'http'
  | 'dm'
  | 'db_update'
  | 'sql_query'
  | 'file_read'
  | 'template_render'
  | 'fan_out'
  // switch 分支节点（画布配置模式，NodeInspector 仅显示帮助）
  | 'switch'

/** 这 5 个有 NodeInspector 专属硬编码 UI；其余走 paramSchema 动态表单 */
export const BESPOKE_STAGE_TYPES: ReadonlySet<StageType> = new Set([
  'script', 'approval', 'llm_agent', 'wait_webhook', 'im_input',
])

export interface ImInputConfig {
  prompt: string
  paramSchema: Record<string, unknown>
  capabilityKey?: string
  timeoutSeconds?: number
}

export interface StageFields extends Record<string, unknown> {
  id: string
  name: string
  stageType: StageType
  targetRoles: string[]
  parallel: boolean
  timeoutSeconds: number
  retryCount: number
  onFailure: 'stop' | 'continue'
  // phase 3 高级字段（retry_when 表达式 + 重试间隔，由 graph-runner 顶层处理）
  retryWhen?: string
  retryDelayMs?: number
  // bespoke 节点独占字段
  script?: string
  containerImage?: string
  approverIds?: string[]
  approvalDescription?: string
  capabilityKey?: string
  capabilityParams?: Record<string, unknown>
  webhookTag?: string
  imInputConfig?: ImInputConfig
  // phase 3 新增 7 节点的统一参数容器（key 决定 schema）
  params?: Record<string, unknown>
  // llm_agent 节点输出格式（'json' 模式下运行时自动 JSON.parse 写入 stepOutputs）
  outputFormat?: 'string' | 'json'
}

export type ConditionSpec =
  | { kind: 'onSuccess' }
  | { kind: 'onFailure' }
  | { kind: 'expression'; expression: string }

export type StageNode = Node<StageFields>

export interface ConditionEdgeData extends Record<string, unknown> {
  condition?: ConditionSpec
  /** switch 出边专属：是否为 default handle 拖出的边 */
  isDefault?: boolean
}
export type StageEdge = Edge<ConditionEdgeData>

// Backend wire format — mirrors src/pipeline/types.ts PipelineGraph.
export interface PipelineGraphWire {
  nodes: Array<StageFields & { position: { x: number; y: number } }>
  edges: Array<{ id: string; source: string; target: string; condition?: ConditionSpec; sourceHandle?: string }>
}
