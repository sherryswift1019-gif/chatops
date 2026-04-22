export interface ImInputConfig {
  /** 首次引导语；支持 {{triggerParams.xxx}}。 */
  prompt: string
  /** 需要采集的参数 JSON Schema（至少 properties+required）。 */
  paramSchema: Record<string, unknown>
  /** 可选：用于加载 system_prompt / 工具白名单增强 Agent 判定（预留，v1 未用）。 */
  capabilityKey?: string
  /** 收集超时（秒），超过则 stage 失败。 */
  timeoutSeconds?: number
}

export interface StageDefinition {
  name: string
  stageType: 'script' | 'approval' | 'capability' | 'wait_webhook' | 'im_input'
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
  /**
   * 动态审批人 resolver 名称——由 src/pipeline/approval-resolvers.ts 的注册表管理。
   * 设置后：graph-builder 运行时调对应 resolver，用 triggerParams 查出 approverIds
   * 和 description，忽略 approverIds/approvalDescription 静态字段。
   *
   * 业务上真实的审批人几乎都是上下文决定的（L3 主仓库 owner / 报销金额判定 / OPS
   * 产品线负责人 …），静态 approverIds 只适合固定流程。resolver 抽象让 pipeline
   * 定义时只关心"审批策略名"，运行时由业务代码决定具体人。
   */
  approverIdsResolver?: string
  // capability stage（研发 AI 助手：触发 Agent capability）
  capabilityKey?: string
  capabilityParams?: Record<string, unknown>
  // wait_webhook stage（等待外部 Webhook 恢复）
  webhookTag?: string
  // im_input stage（IM 对话式参数采集）
  imInputConfig?: ImInputConfig
}

export function getStageType(stage: StageDefinition): 'script' | 'approval' | 'capability' | 'wait_webhook' | 'im_input' {
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
  // IM 触发时的上下文（im_input stage 需要；其他 stage 可忽略）
  triggerPlatform?: string
  triggerGroupId?: string
  triggerUserId?: string
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
