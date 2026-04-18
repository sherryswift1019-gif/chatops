export interface StageDefinition {
  name: string
  stageType: 'script' | 'approval'
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
}

export function getStageType(stage: StageDefinition): 'script' | 'approval' {
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
