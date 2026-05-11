import client from './client'

export type RequirementStatus =
  | 'draft' | 'queued' | 'spec_review' | 'planning' | 'developing'
  | 'reviewing' | 'testing' | 'mr_pending' | 'mr_open' | 'merged'
  | 'aborting' | 'aborted' | 'failed'

export type ApprovalDecision =
  | 'approved'
  | 'rejected'
  | 'rejected_plan'
  | 'rejected_spec'
  | 'force_passed'
  | 'budget_extended'
  | 'aborted'
  | 'fix'

export interface RequirementDTO {
  id: number
  title: string
  rawInput: string
  status: RequirementStatus
  branch: string | null
  baseBranch: string
  gitlabProject: string
  worktreePath: string | null
  pipelineRunId: number | null
  currentStage: string | null
  specContent: string | null
  planContent: string | null
  mrUrl: string | null
  abortReason: string | null
  retryCounters: Record<string, unknown>
  source: 'web' | 'im' | 'api'
  createdBy: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export interface ApprovalWaiterDTO {
  id: number
  requirementId: number
  pipelineRunId: number
  nodeId: string
  approvalKind: 'spec' | 'plan' | 'final' | 'escalation' | 'qi_e2e_intervention' | 'qi_sandbox_failed'
  round: number
  decisionSet: 'binary' | 'escalation' | 'qi_e2e_intervention' | 'qi_sandbox_failed' | 'plan_escalation' | 'human_gate'
  imPlatform: string | null
  imGroupId: string | null
  contextSummary: string | null
  claimedBy: 'im' | 'web' | 'retry' | 'abort' | null
  claimedAt: string | null
  decision: ApprovalDecision | null
  rejectReason: string | null
  budgetDelta: number | null
  decidedBy: string | null
  createdAt: string
}

export interface RequirementDetailDTO extends RequirementDTO {
  waiters: ApprovalWaiterDTO[]
  /** v2: 最近一次 test_run 的 stage_results（含 v2 结构化字段） */
  stageResults: V2StageResult[] | null
}

// v2 stage_results 类型定义（与 src/db/repositories/test-runs.ts 同步）
// 详见 docs/prds/quick-impl-roles-v2/02-data-flow.md §5
export interface V2StageResult {
  name: string
  type: string
  status: 'pending' | 'running' | 'waiting' | 'success' | 'failed' | 'skipped'
  startedAt?: string
  finishedAt?: string
  durationMs?: number
  output?: string
  error?: string
  artifactPath?: string
  /** role-specific 结构化输出（v2 + v3） */
  skillOutput?: {
    summary?: string
    decision?: 'pass' | 'fail' | 'reject_input'
    // ===== v3 spec-author 新增字段（全 optional 兼容老数据）=====
    schemaVersion?: 'v2'
    confidenceLevel?: 'high' | 'medium' | 'low'
    reviewHints?: Array<{ severity: 'high' | 'medium' | 'low'; point: string; reason: string }>
    noGos?: Array<{ desc: string; reason?: string }>
    // spec-author
    acceptanceCriteria?: Array<{ id: string; format?: string; text: string }>
    openQuestions?: string[]
    risks?: Array<{ desc: string; severity: 'high' | 'medium' | 'low' }>
    references?: Array<{ file: string; line?: number; purpose: string }>
    // v3: clarifications 加 kind / userMayDisagreeIf
    clarifications?: Array<{
      q: string
      a: string
      kind?: 'fact' | 'assumption'
      userMayDisagreeIf?: string
    }>
    // plan-decomposer
    tasks?: Array<{
      id: string
      type: 'feature' | 'test' | 'migration' | 'doc' | 'refactor' | 'chore'
      title: string
      files: string[]
      coverAC?: string[]
      dependsOn?: string[]
      estimatedLoc?: number
    }>
    migrations?: Array<{ file: string; rollbackPlan: string }>
    // dev-loop
    commits?: Array<{
      taskId: string
      sha: string
      message: string
      filesChanged: string[]
      tsc: 'pass' | 'fail'
      vitest?: { command: string; passed: number; failed: number }
      round?: number
      isFix?: boolean
    }>
    skippedTasks?: Array<{ taskId: string; reason: string }>
    failedTasks?: Array<{ taskId: string; reason: string }>
    // reviewer
    specCoverage?: Array<
      | { ac: string; covered: true; evidence: Array<{ file: string; line?: number }> }
      | { ac: string; covered: false; missingReason: string }
    >
    scopeViolations?: Array<{ file: string; reason: string }>
    fileRisks?: Array<{
      file: string
      role: string
      impact: string
      risk: 'low' | 'medium' | 'high'
      focusOn: string
    }>
  }
  evidence?: {
    // v3: standardsConsulted 升级为 union（兼容老 string[] / 新 {file, usedFor}[]）
    standardsConsulted?: Array<string | { file: string; usedFor: string }>
    // v3: selfCheck 升级为 union（兼容老 mechanical {item, passed, reason} / 新主观 {item, answer}）
    selfCheck?: Array<
      | { item: string; passed: boolean; reason?: string }
      | { item: string; answer: string }
    >
  }
  rounds?: Array<{
    round: number
    decision?: string
    summary?: string
    rejectReason?: string
    skillOutput?: V2StageResult['skillOutput']
    truncated?: boolean
  }>
  acDiff?: {
    added: Array<{ id: string; text: string }>
    removed: string[]
    changed: Array<{ id: string; oldText: string; newText: string }>
  }
}

export interface ListRequirementsResult {
  items: RequirementDTO[]
  total: number
}

export const requirementsApi = {
  list(params?: { status?: string; page?: number; size?: number }): Promise<ListRequirementsResult> {
    return client.get('/requirements', { params }).then(r => r.data)
  },

  get(id: number): Promise<RequirementDetailDTO> {
    return client.get(`/requirements/${id}`).then(r => r.data)
  },

  create(body: {
    title: string
    rawInput: string
    gitlabProject: string
    baseBranch?: string
    createdBy?: string
  }): Promise<RequirementDTO> {
    return client.post('/requirements', body).then(r => r.data)
  },

  update(id: number, body: {
    title?: string
    rawInput?: string
    gitlabProject?: string
    baseBranch?: string
  }): Promise<RequirementDTO> {
    return client.patch(`/requirements/${id}`, body).then(r => r.data)
  },

  delete(id: number): Promise<void> {
    return client.delete(`/requirements/${id}`).then(() => undefined)
  },

  run(id: number): Promise<RequirementDTO> {
    return client.post(`/requirements/${id}/run`).then(r => r.data)
  },

  abort(id: number): Promise<{ success: boolean }> {
    return client.post(`/requirements/${id}/abort`).then(r => r.data)
  },

  decide(
    requirementId: number,
    waiterId: number,
    body: {
      decision: ApprovalDecision
      rejectReason?: string | null
      budgetDelta?: number | null
      decidedBy?: string | null
      /** PRD §7 step 6: 仅 plan_escalation rejected_plan 时填 */
      targetTaskId?: string | null
      /** PRD §7 step 6: 仅 plan_escalation rejected_plan 时填 */
      citedAiNotes?: string[] | null
    },
  ): Promise<{ ok: boolean; resumed: boolean; waiter: ApprovalWaiterDTO }> {
    return client.post(`/requirements/${requirementId}/approvals/${waiterId}`, body).then(r => r.data)
  },
}
