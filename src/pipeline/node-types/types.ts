import type { TaskContext } from '../../agent/tools/types.js'

/** 节点执行结果 —— pipeline 引擎据此决定 retryWhen / 边 when / 下游是否激活 */
export interface NodeExecutionResult {
  status: 'success' | 'failed' | 'skipped'
  output: Record<string, unknown>
  error?: string
}

/** 执行上下文 —— 节点 executor 拿到的所有运行时信息 */
export interface ExecutionContext {
  runId: number
  pipelineId: number
  nodeId: string
  triggerParams: Record<string, unknown>
  vars: Record<string, unknown>
  /** 已执行节点的输出，按 nodeId 索引 */
  steps: Record<string, { status: 'success' | 'failed' | 'skipped'; output: Record<string, unknown> }>
  /** fan_out 注入的局部变量（阶段 3 才会非空） */
  scopes?: Record<string, Record<string, unknown>>
  /**
   * 当前节点的目标服务器（script / file_read 等远程操作类节点使用）。
   * password 是 SSH 凭据；resolveContext 时由调用方填充，executor 内部不应做凭据查询。
   * Phase 3：单 server 模型——fan_out / 多 role 由调度器在外层展开后逐一调 executor。
   */
  server?: { host: string; port: number; username: string; password?: string }
  /** 透传给 capability stage 的 TaskContext */
  taskContext?: TaskContext
}

export interface NodeExecutor {
  key: string
  /** v1：直接 async；阶段 3 fan_out 节点需要扩展为支持子图调度 */
  execute(params: Record<string, unknown>, ctx: ExecutionContext): Promise<NodeExecutionResult>
}
