export interface StageDefinition {
  name: string
  stageType: 'script' | 'approval' | 'capability' | 'wait_webhook'
  targetRoles: string[]
  parallel: boolean
  timeoutSeconds: number
  retryCount: number
  onFailure: 'stop' | 'continue'
  // script stage
  script?: string
  // approval stage
  approverIds?: string[]
  approvalDescription?: string
  // capability stage（研发 AI 助手：触发 Agent capability）
  capabilityKey?: string
  capabilityParams?: Record<string, unknown>
  // wait_webhook stage（等待外部 Webhook 恢复）
  webhookTag?: string
}

export function getStageType(stage: StageDefinition): 'script' | 'approval' | 'capability' | 'wait_webhook' {
  return stage.stageType ?? 'script'
}

export interface ServerInfo {
  id: number
  host: string
  port: number
  username: string
  password: string
  role: string
}

export interface StageContext {
  runId: number
  stageIndex: number
  servers: Record<string, ServerInfo[]>
  logDir: string
  // Extended context for variable resolution
  productLine?: { name: string; displayName: string }
  pipeline?: { id: number; name: string }
  run?: { id: number; triggeredBy: string; triggerType: string }
  variables?: Record<string, string>
}

export interface StageExecutionResult {
  status: 'success' | 'failed'
  output: string
  error?: string
  artifacts?: string[]
}

export interface ArtifactInput {
  name: string
  listUrl: string
  glob: string
  outputVar: string
  valueFrom: 'url' | 'name' | 'path'
  default?: string
  defaultStrategy?: 'latest-by-mtime' | 'first-match'
  authHeaders?: Record<string, string>
}

// ---- Visual canvas DAG model ---------------------------------------------
// StageDefinition 字段在节点内部复用；画布仅增加 id / position / edges。

export type ConditionSpec =
  | { kind: 'onSuccess' }
  | { kind: 'onFailure' }
  | { kind: 'expression'; expression: string }
// expression 首版只支持两种模板（详见 graph-builder conditionMatches）：
//   1. status === 'success' | 'failed' | 'skipped'
//   2. output.includes('...')

export interface PipelineNode extends StageDefinition {
  id: string                        // ULID
  position: { x: number; y: number }
}

export interface PipelineEdge {
  id: string                        // ULID
  source: string                    // PipelineNode.id
  target: string                    // PipelineNode.id
  condition?: ConditionSpec
}

export interface PipelineGraph {
  nodes: PipelineNode[]
  edges: PipelineEdge[]
}
