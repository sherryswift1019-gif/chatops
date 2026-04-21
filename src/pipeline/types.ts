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
