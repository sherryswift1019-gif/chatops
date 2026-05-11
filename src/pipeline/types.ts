/**
 * Phase 3 引入的 7 种 NodeExecutor 类型字面量。
 * graph-builder switch 通过这些 union 落到通用 dispatch（buildExecutorNode）。
 * 注：这些类型对应的运行时参数走 PipelineNode.params (松散字段)，不在 StageDefinition
 * 上分别声明字段——参数 schema 由 src/pipeline/node-types/*.ts 各 executor 自行约定。
 */
export type ExecutorNodeStageType =
  | 'sql_query'
  | 'http'
  | 'db_update'
  | 'dm'
  | 'file_read'
  | 'template_render'
  | 'fan_out'
  | 'switch'
  | 'end'
  | 'cleanup'
  | 'git_commit_push'

export interface StageDefinition {
  name: string
  stageType:
    | 'script'
    | 'approval'
    | 'llm_agent'
    | 'wait_webhook'
    | 'skill_node'
    | 'skill_with_approval'
    | 'skill_with_review'
    | 'llm_author'
    | 'llm_review'
    | 'mr_create'
    | 'init_qi_branch'
    | 'e2e_stub'
    | 'qi_e2e_runner'
    | 'im_input'
    | ExecutorNodeStageType
  targetRoles: string[]
  parallel: boolean
  timeoutSeconds: number
  retryCount: number
  onFailure: 'stop' | 'continue'
  // script stage
  script?: string
  containerImage?: string
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
  /** 仅对 llm_agent 节点有意义。运行时默认 'json'（stage 级默认）；旧 graph 经 v44 migration 显式补 'string' 保现状 */
  outputFormat?: 'string' | 'json'
  // llm_agent custom 模式
  agentMode?: 'capability' | 'custom'
  customPrompt?: string
  allowedTools?: string[]
  // wait_webhook stage（等待外部 Webhook 恢复）
  webhookTag?: string
}

export function getStageType(stage: StageDefinition): StageDefinition['stageType'] {
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
  /**
   * Mirror of `state.stepOutputs` injected by buildScriptNode so that
   * runScript hooks can resolve `{{steps.<id>.output.x}}` templates
   * against upstream node outputs. Optional for legacy callers that
   * never hit a stepOutputs-using script; absent ≡ empty map.
   */
  stepOutputs?: Record<string, unknown>
  /**
   * Per-run trigger parameters injected by buildScriptNode so that
   * runScript hooks can resolve `{{triggerParams.x}}` templates against
   * the values passed in at pipeline trigger time. Mirrors how capability
   * / NodeExecutor nodes already receive triggerParams; script nodes used
   * to drop them on the floor (the SSH timeout in PAM Proxy install.sh).
   * Absent ≡ empty map.
   */
  triggerParams?: Record<string, unknown>
  // IM 触发时的上下文（im-param-collector 使用）
  triggerPlatform?: string
  triggerGroupId?: string
  triggerUserId?: string
}

/**
 * Per-server (or per-docker-exec) structured execution detail.
 *
 * Filled in by the SSH script hook (`runScriptOnServers` 收集 per-server 数据)
 * and by `runScriptInDocker` (单条虚拟 entry: host="", role="docker"). Other
 * hooks (capability / customAgent) leave `StageExecutionResult.servers`
 * undefined.
 *
 * Surfaced to downstream pipeline nodes via `state.stepOutputs[<scriptNodeId>]`
 * as both top-level shortcut fields (host/stdout/stderr/exitCode/role/success
 * — for the "first failure or first success" server) and the full
 * `servers: ServerExecutionDetail[]` array.
 *
 * `exitCode === -1` indicates the SSH connection itself failed (timeout /
 * connection refused / etc.) — the underlying process never reached an
 * exit. `error` carries the error string in that case. For Docker / normal
 * SSH paths, `exitCode` matches the real process exit code.
 */
export interface ServerExecutionDetail {
  host: string
  port: number
  role: string
  stdout: string
  stderr: string
  exitCode: number
  success: boolean
  error?: string
}

export interface StageExecutionResult {
  status: 'success' | 'failed'
  output: string
  error?: string
  artifacts?: string[]
  /**
   * Structured per-server execution details. Populated only by SSH/Docker
   * `script` stage hooks; absent for capability / customAgent / executor
   * nodes (those publish their structured output through other channels).
   *
   * `buildScriptNode` reads this to populate `state.stepOutputs[<id>]` so
   * downstream `{{steps.<scriptNodeId>.output.<field>}}` templates resolve
   * to real values instead of dangling literal `{{...}}` placeholders.
   */
  servers?: ServerExecutionDetail[]
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
