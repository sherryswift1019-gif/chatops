export type StageType = 'cleanup' | 'download' | 'install' | 'health_check' | 'test' | 'report' | 'custom'

export interface StageDefinition {
  name: string
  type?: StageType
  capabilityKey?: string
  targetRoles: string[]
  parallel: boolean
  timeoutSeconds: number
  retryCount: number
  params: Record<string, unknown>
  onFailure: 'stop' | 'continue'
}

const LEGACY_TYPE_MAP: Record<string, string> = {
  cleanup: 'env_cleanup', download: 'deploy', install: 'deploy',
  health_check: 'health_check', test: 'auto_test',
  report: 'report_gen', custom: 'custom_script',
}

export function getStageOperationKey(stage: StageDefinition): string {
  if (stage.capabilityKey) return stage.capabilityKey
  return LEGACY_TYPE_MAP[stage.type ?? ''] ?? stage.type ?? 'custom_script'
}

export interface CleanupParams {
  script: string
  args?: string[]
  preCommands?: string[]
}

export interface DownloadParams {
  sourceUrl: string
  destPath: string
  checksum?: string
  extract: boolean
}

export interface InstallParams {
  workDir: string
  script: string
  configFile: string
  configValues: Record<string, string>
  silentFlag: string
}

export interface HealthCheckParams {
  checkType: 'http' | 'tcp' | 'command'
  target: string
  intervalSeconds: number
  maxRetries: number
}

export interface TestParams {
  gitRepo: string
  branch: string
  workDir: string
  command: string
  collectArtifacts: string[]
}

export interface ReportParams {
  format: 'html'
  includeStageLogs: boolean
}

export interface CustomParams {
  command: string
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
}

export interface StageExecutionResult {
  status: 'success' | 'failed'
  output: string
  error?: string
  artifacts?: string[]
}
