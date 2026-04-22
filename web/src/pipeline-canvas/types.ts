import type { Node, Edge } from '@xyflow/react'

export type StageType = 'script' | 'approval' | 'capability' | 'wait_webhook' | 'im_input'

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
  script?: string
  approverIds?: string[]
  approvalDescription?: string
  capabilityKey?: string
  capabilityParams?: Record<string, unknown>
  webhookTag?: string
  imInputConfig?: ImInputConfig
}

export type ConditionSpec =
  | { kind: 'onSuccess' }
  | { kind: 'onFailure' }
  | { kind: 'expression'; expression: string }

export type StageNode = Node<StageFields>

export interface ConditionEdgeData extends Record<string, unknown> {
  condition?: ConditionSpec
}
export type StageEdge = Edge<ConditionEdgeData>

// Backend wire format — mirrors src/pipeline/types.ts PipelineGraph.
export interface PipelineGraphWire {
  nodes: Array<StageFields & { position: { x: number; y: number } }>
  edges: Array<{ id: string; source: string; target: string; condition?: ConditionSpec }>
}
