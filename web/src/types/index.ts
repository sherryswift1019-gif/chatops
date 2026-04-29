export interface ProductLine {
  id: number; name: string; displayName: string; description: string; createdAt: string; updatedAt: string
}

export interface ProductLineMember {
  id: number; productLineId: number; userId: string; userName: string
  role: 'developer' | 'tester' | 'ops' | 'admin'; createdAt: string
}

export interface ProductLineEnv {
  id: number; productLineId: number; envId: number
  runtime: 'kubernetes' | 'docker'; namespace: string; enabled: boolean
  connectionConfig: Record<string, unknown>
  defaultBranch: string
}

export interface Project {
  id: number; productLineId: number; name: string; displayName: string
  gitlabPath: string; harborProject: string; ownerId: string; ownerName: string
  dockerContainerName: string; k8sProjectName: string; composePath: string
  description: string; createdAt: string; updatedAt: string
}

export interface Environment {
  id: number; name: string; displayName: string; sortOrder: number; createdAt: string
}

export interface ApprovalRule {
  id: number; productLineId: number | null; imTriggerKey: string; env: string
  primaryApprovers: string[]; backupApprovers: string[]
  primaryTimeoutMin: number; totalTimeoutMin: number
}

export interface DingTalkUser {
  userId: string; name: string; avatar: string; department: string
  email?: string; syncedAt?: string
  resignedAt: string | null
}

export interface DingTalkUsersResponse { users: DingTalkUser[]; total: number }

export interface SystemConfigEntry {
  key: string; value: Record<string, unknown>; updatedAt: string
}

export interface DingTalkStatus {
  configured: boolean
  started: boolean
  startedAt: number | null
  lastEventAt: number | null
  startError: string | null
  connected: boolean
  needsRestart: boolean
}

export interface ConnectionTestResult {
  ok: boolean
  user?: { username: string; name: string; email: string | null }
  error?: string
}

export interface TestServer {
  id: number; productLineId: number; name: string; host: string; port: number
  username: string; authType: 'password' | 'key'; credential: string; role: string
  status: 'idle' | 'in_use' | 'offline'; tags: Record<string, unknown>
  createdAt: string; updatedAt: string
}

export interface TestPipeline {
  id: number; productLineId?: number; name: string; description: string
  graph?: unknown | null
  stages: StageDefinition[]; serverRoles?: Record<string, { count: number }>
  variables?: Record<string, string>
  artifactInputs?: ArtifactInput[]
  containerImage?: string | null
  paramSchema?: Record<string, unknown> | null
  imPrompt?: string | null
  schedule?: string; enabled: boolean; triggerParams: Record<string, unknown>; createdAt: string; updatedAt: string
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

export interface StageDefinition {
  name: string
  stageType: 'script' | 'approval' | 'llm_agent' | 'wait_webhook'
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
  /** 动态审批人 resolver 名（如 primary_project_owner），详见后端 approval-resolvers.ts */
  approverIdsResolver?: string
  // capability stage（研发 AI 助手）
  capabilityKey?: string
  capabilityParams?: Record<string, unknown>
  // wait_webhook stage
  webhookTag?: string
}

export interface TestRun {
  id: number; pipelineId: number; triggerType: 'manual' | 'api' | 'scheduled'
  triggeredBy: string; triggeredByName?: string; triggeredByAvatar?: string
  status: 'pending' | 'running' | 'success' | 'failed' | 'cancelled'
  servers: Record<string, string[]>; currentStage: number
  stageResults: StageResult[]; reportPath: string
  startedAt: string | null; finishedAt: string | null; errorMessage: string; createdAt: string
}

export interface StageResult {
  name: string; type: string; status: 'pending' | 'running' | 'waiting' | 'success' | 'failed' | 'skipped'
  startedAt?: string; finishedAt?: string; durationMs?: number; output?: string; error?: string
  aiAnalysis?: string
}

// ─── 研发 AI 助手类型 ───────────────────────────────────────────

export interface BugAnalysisReport {
  id: number; issueId: number; issueUrl: string; productLineId: number
  agentSessionId: string | null; level: string; classification: string
  confidence: string; confidenceScore: number | null
  rootCauseSummary: string | null; solutionsJson: Solution[]
  affectedModules: string[] | null; analysisSteps: string[] | null
  metadata: Record<string, unknown> | null; status: string
  pipelineRunId: number | null; primaryProjectPath: string | null
  triggeredBy: string | null
  createdAt: string; updatedAt: string
  productLineName?: string
  completedAt: string | null
}

export interface Solution {
  id: string; summary: string; recommended: boolean; risk: string; effort: string
}

export interface ProductKnowledgeRepo {
  id: number; productLineId: number; codeRepoUrl: string; codeDefaultBranch: string
  knowledgeRepoUrl: string; aiSummaryPath: string
  imageStorageConfig: Record<string, unknown> | null; createdAt: string
}

export interface KnowledgeHitStat {
  id: number; entryId: string; productLineId: number
  hitCount: number; lastHitAt: string | null; updatedAt: string
}

export interface MetricDaily {
  id: number; date: string; productLineId: number | null
  metricKey: string; metricValue: number; metadata: Record<string, unknown> | null
}

export type PrdStatus =
  | 'drafting'
  | 'reviewing'
  | 'review_blocked'
  | 'draft'
  | 'approved'
  | 'archived'

export interface PrdReviewFinding {
  id: string
  dimension: string
  severity: 'blocker' | 'major' | 'minor'
  location: string
  description: string
  suggestion?: string
  canAutoFix: boolean
  autoFixBlockedReason?: string
  ownership?: 'pm' | 'admin' | 'business'
  recommendation?: {
    action: 'approve' | 'approve_with_edits' | 'reject'
    reason: string
  }
}

export interface PrdReviewResult {
  status: 'passed' | 'blocked'
  round: number
  findings: PrdReviewFinding[]
  recommendation?: {
    action: 'approve' | 'approve_with_edits' | 'reject'
    reason: string
  }
  reviewedAt: string
}

export interface PrdReviewHistoryEntry {
  round: number
  result: PrdReviewResult
  repairedAt?: string
  repairSummary?: string
}

export interface PrdDocument {
  id: number
  productLineId: number
  title: string
  version: number
  status: PrdStatus
  contentMarkdown: string
  contentJson: Record<string, unknown>
  reviewResult: PrdReviewResult | null
  reviewHistory: PrdReviewHistoryEntry[]
  createdBy: string
  groupId: string | null
  platform: string | null
  agentSessionId: string | null
  tags: string[]
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export type PrdChatRole = 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'error'

export interface PrdChatMessageMetadata {
  /** 特殊 bubble 类型，例如 'review_progress' */
  kind?: string
  /** review_progress 阶段 */
  stage?: string
  prdId?: number
  /** review_progress 完整事件 payload */
  payload?: Record<string, unknown>
  [key: string]: unknown
}

export interface PrdChatSession {
  id: number
  sessionKey: string
  prdId: number | null
  productLineId: number
  createdBy: string
  porygonSessionId: string | null
  lastActiveAt: string
  createdAt: string
}

export interface PrdChatMessage {
  id: number
  sessionKey: string
  role: PrdChatRole
  content: string
  toolName: string | null
  toolUseId: string | null
  metadata: PrdChatMessageMetadata
  createdAt: string
}

export interface PipelineWebhook {
  id: number
  pipelineId: number
  name: string
  /** 列表里是 masked（前8字符+省略号），create/rotate 响应里是完整 token */
  token: string
  enabled: boolean
  defaultServers: Record<string, string[]> | null
  createdAt: string
  createdBy: string
  lastUsedAt: string | null
  lastRunId: number | null
  triggerCount: number
  // url? 已移除：url 只在 create/rotate 时由 API 函数返回类型单独声明
}
