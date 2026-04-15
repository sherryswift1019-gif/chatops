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
  id: number; productLineId: number | null; action: string; env: string
  primaryApprovers: string[]; backupApprovers: string[]
  primaryTimeoutMin: number; totalTimeoutMin: number
}

export interface DingTalkUser {
  userId: string; name: string; avatar: string; department: string; syncedAt: string
}

export interface DingTalkUsersResponse { users: DingTalkUser[]; total: number }

export interface SystemConfigEntry {
  key: string; value: Record<string, unknown>; updatedAt: string
}

export interface TestServer {
  id: number; productLineId: number; name: string; host: string; port: number
  username: string; authType: 'password' | 'key'; credential: string; role: string
  status: 'idle' | 'in_use' | 'offline'; tags: Record<string, unknown>
  createdAt: string; updatedAt: string
}

export interface TestPipeline {
  id: number; productLineId: number; name: string; description: string
  stages: StageDefinition[]; serverRoles: Record<string, { count: number }>
  variables?: Record<string, string>
  schedule: string; enabled: boolean; triggerParams: Record<string, unknown>; createdAt: string; updatedAt: string
}

export interface StageDefinition {
  name: string
  stageType: 'script' | 'approval'
  targetRoles: string[]
  parallel: boolean
  timeoutSeconds: number
  retryCount: number
  onFailure: 'stop' | 'continue'
  script?: string
  approverIds?: string[]
  approvalDescription?: string
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
  name: string; type: string; status: 'pending' | 'running' | 'success' | 'failed' | 'skipped'
  startedAt?: string; finishedAt?: string; durationMs?: number; output?: string; error?: string
  aiAnalysis?: string
}
