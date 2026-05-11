import { getPool } from '../client.js'

export interface TestRun {
  id: number
  pipelineId: number
  triggerType: 'manual' | 'api' | 'scheduled' | 'im'
  triggeredBy: string
  status: 'pending' | 'running' | 'success' | 'failed' | 'cancelled'
  servers: Record<string, string[]>
  currentStage: number
  stageResults: StageResult[]
  reportPath: string
  startedAt: Date | null
  finishedAt: Date | null
  errorMessage: string
  createdAt: Date
  runtimeVars: Record<string, string>
  triggerParams: Record<string, unknown>
}

export interface StageResult {
  name: string
  type: string
  status: 'pending' | 'running' | 'waiting' | 'success' | 'failed' | 'skipped'
  startedAt?: string
  finishedAt?: string
  durationMs?: number
  output?: string
  error?: string
  aiAnalysis?: string

  // v2 扩展（quick-impl-roles-v2 §3.1.6）
  /** 产出物文件路径（spec.md / plan.md） */
  artifactPath?: string
  /** role-specific 结构化输出（acceptanceCriteria / tasks / commits / specCoverage 等） */
  skillOutput?: Record<string, unknown>
  /** 自检 + standards 引用证据 */
  evidence?: { standardsConsulted?: string[]; selfCheck?: Array<{ item: string; passed: boolean; reason?: string }> }
  /** 多轮记录：每 round append 一项；最近 2 轮保留完整结构，更早 round 摘要化 */
  rounds?: Array<StageRoundEntry>
  /** AC 差异（spec round > 1 时由 skill-runner 计算，触发 plan 节点级联失效） */
  acDiff?: {
    added: Array<{ id: string; text: string }>
    removed: string[]
    changed: Array<{ id: string; oldText: string; newText: string }>
  }
  /** 节点级 metric / feature flag 缓存（v3 摘要灰度路由 / zod parse 状态等）*/
  meta?: Record<string, unknown>
}

export interface StageRoundEntry {
  round: number
  decision?: 'pass' | 'fail' | 'rejected' | 'approved' | 'force_passed' | 'aborted'
  summary?: string
  rejectReason?: string
  /** 完整 skillOutput；裁剪后只保留 summary/decision/rejectReason，其他字段被删 */
  skillOutput?: Record<string, unknown>
  evidence?: StageResult['evidence']
  artifactPath?: string
  /** 是否被裁剪（膨胀控制 N=2，更早的 round 设 true） */
  truncated?: boolean
}

function mapRow(r: Record<string, unknown>): TestRun {
  return {
    id: r.id as number, pipelineId: r.pipeline_id as number,
    triggerType: r.trigger_type as TestRun['triggerType'],
    triggeredBy: (r.triggered_by ?? '') as string,
    status: r.status as TestRun['status'],
    servers: (r.servers ?? {}) as Record<string, string[]>,
    currentStage: r.current_stage as number,
    stageResults: (r.stage_results ?? []) as StageResult[],
    reportPath: (r.report_path ?? '') as string,
    startedAt: r.started_at as Date | null,
    finishedAt: r.finished_at as Date | null,
    errorMessage: (r.error_message ?? '') as string,
    createdAt: r.created_at as Date,
    runtimeVars: (r.runtime_vars ?? {}) as Record<string, string>,
    triggerParams: (r.trigger_params ?? {}) as Record<string, unknown>,
  }
}

export async function listTestRuns(
  pipelineId: number | null,
  page: number,
  limit: number
): Promise<{ data: TestRun[]; total: number }> {
  const pool = getPool()
  const offset = (page - 1) * limit

  const [dataResult, countResult] = await Promise.all([
    pool.query(
      `SELECT * FROM test_runs
       WHERE ($1::int IS NULL OR pipeline_id = $1)
       ORDER BY id DESC
       LIMIT $2 OFFSET $3`,
      [pipelineId, limit, offset]
    ),
    pool.query(
      `SELECT COUNT(*) AS count FROM test_runs
       WHERE ($1::int IS NULL OR pipeline_id = $1)`,
      [pipelineId]
    ),
  ])

  return {
    data: dataResult.rows.map(mapRow),
    total: parseInt(countResult.rows[0].count, 10),
  }
}

export async function getTestRunById(id: number): Promise<TestRun | null> {
  const pool = getPool()
  const { rows } = await pool.query('SELECT * FROM test_runs WHERE id = $1', [id])
  return rows[0] ? mapRow(rows[0]) : null
}

export async function createTestRun(data: {
  pipelineId: number; triggerType: TestRun['triggerType']; triggeredBy: string
  servers: Record<string, string[]>
  runtimeVars?: Record<string, string>
  triggerParams?: Record<string, unknown>
}): Promise<TestRun> {
  const pool = getPool()
  const { rows } = await pool.query(
    `INSERT INTO test_runs (pipeline_id, trigger_type, triggered_by, servers, runtime_vars, trigger_params, status, started_at)
     VALUES ($1,$2,$3,$4,$5,$6,'running',NOW()) RETURNING *`,
    [data.pipelineId, data.triggerType, data.triggeredBy,
     JSON.stringify(data.servers), JSON.stringify(data.runtimeVars ?? {}),
     JSON.stringify(data.triggerParams ?? {})]
  )
  return mapRow(rows[0])
}

export async function updateTestRunStage(id: number, currentStage: number, stageResults: StageResult[]): Promise<void> {
  const pool = getPool()
  await pool.query(
    'UPDATE test_runs SET current_stage = $2, stage_results = $3 WHERE id = $1',
    [id, currentStage, JSON.stringify(stageResults)]
  )
}

export async function finishTestRun(id: number, status: 'success' | 'failed' | 'cancelled', reportPath: string, errorMessage = ''): Promise<void> {
  const pool = getPool()
  await pool.query(
    'UPDATE test_runs SET status = $2, report_path = $3, error_message = $4, finished_at = NOW() WHERE id = $1',
    [id, status, reportPath, errorMessage]
  )
}

/** Reset a run's status without touching finishedAt / errorMessage (used by retryFailedRun). */
export async function updateTestRunStatus(id: number, status: TestRun['status']): Promise<void> {
  const pool = getPool()
  await pool.query('UPDATE test_runs SET status = $2 WHERE id = $1', [id, status])
}

/** Returns all test_runs with status='running', optionally filtered to a specific pipeline. */
export async function listRunningTestRuns(pipelineId?: number): Promise<TestRun[]> {
  const pool = getPool()
  const { rows } = await pool.query(
    `SELECT * FROM test_runs WHERE status = 'running'${pipelineId != null ? ' AND pipeline_id = $1' : ''} ORDER BY id`,
    pipelineId != null ? [pipelineId] : [],
  )
  return rows.map(mapRow)
}

/**
 * v2 §3.1.6：把单 stage 的结构化输出写入 stage_results[stageIdx]。
 * 用 jsonb 路径 update 避免读改写时的 race condition（同一 run 多 stage 并行写入）。
 *
 * 行为：
 * - 把 patch 字段 merge 到 stage_results[stageIdx]（顶层 key 覆盖；不做 deep merge）
 * - 如果 patch 含 round 信息（即 patch.skillOutput / patch.evidence / patch.artifactPath
 *   / patch.acDiff 中任一），同时 append 一项到 rounds[]，并对 rounds 做膨胀控制：
 *   只保留最近 2 轮完整结构，更早 round 裁剪为 {round, decision, summary, rejectReason, truncated:true}
 *
 * 膨胀控制阈值见 docs/prds/quick-impl-roles-v2/02-data-flow.md §5。
 */
const ROUNDS_RETENTION = 2

export interface AppendStageResultPatch {
  // status / 时间戳类
  status?: StageResult['status']
  startedAt?: string
  finishedAt?: string
  durationMs?: number
  error?: string
  // v2 字段
  artifactPath?: string
  skillOutput?: Record<string, unknown>
  evidence?: StageResult['evidence']
  acDiff?: StageResult['acDiff']
  /** 节点级 metric/flag 缓存；浅合并保留 existing keys */
  meta?: Record<string, unknown>
  // 多轮场景：本次写入对应的 round（不传则不 append rounds[]）
  round?: number
  decision?: StageRoundEntry['decision']
  summary?: string
  rejectReason?: string
}

export async function appendStageResult(
  testRunId: number,
  stageIdx: number,
  patch: AppendStageResultPatch,
): Promise<void> {
  const pool = getPool()
  // 读 → merge → 写（同 stage 上写入顺序由调用方保证，graph 内同一 stage 不会并发）
  const { rows } = await pool.query(
    'SELECT stage_results FROM test_runs WHERE id = $1',
    [testRunId],
  )
  if (!rows[0]) {
    throw new Error(`[appendStageResult] test_run ${testRunId} not found`)
  }
  const stageResults = (rows[0].stage_results ?? []) as StageResult[]
  while (stageResults.length <= stageIdx) {
    stageResults.push({ name: `stage-${stageResults.length}`, type: 'unknown', status: 'pending' })
  }
  const cur = stageResults[stageIdx]!

  // 顶层 merge
  if (patch.status !== undefined) cur.status = patch.status
  if (patch.startedAt !== undefined) cur.startedAt = patch.startedAt
  if (patch.finishedAt !== undefined) cur.finishedAt = patch.finishedAt
  if (patch.durationMs !== undefined) cur.durationMs = patch.durationMs
  if (patch.error !== undefined) cur.error = patch.error
  if (patch.artifactPath !== undefined) cur.artifactPath = patch.artifactPath
  if (patch.skillOutput !== undefined) cur.skillOutput = patch.skillOutput
  if (patch.evidence !== undefined) cur.evidence = patch.evidence
  if (patch.acDiff !== undefined) cur.acDiff = patch.acDiff
  if (patch.meta !== undefined) cur.meta = { ...(cur.meta ?? {}), ...patch.meta }

  // append rounds[] + 膨胀控制
  if (patch.round !== undefined) {
    cur.rounds = cur.rounds ?? []
    const newEntry: StageRoundEntry = {
      round: patch.round,
      decision: patch.decision,
      summary: patch.summary,
      rejectReason: patch.rejectReason,
      skillOutput: patch.skillOutput,
      evidence: patch.evidence,
      artifactPath: patch.artifactPath,
    }
    cur.rounds.push(newEntry)
    // 裁剪：保留最近 N 轮完整，更早的 round 删除 skillOutput/evidence/artifactPath，标 truncated
    if (cur.rounds.length > ROUNDS_RETENTION) {
      const cutoff = cur.rounds.length - ROUNDS_RETENTION
      for (let i = 0; i < cutoff; i++) {
        const r = cur.rounds[i]!
        if (r.truncated) continue
        delete r.skillOutput
        delete r.evidence
        delete r.artifactPath
        r.truncated = true
      }
    }
  }

  await pool.query(
    'UPDATE test_runs SET stage_results = $2 WHERE id = $1',
    [testRunId, JSON.stringify(stageResults)],
  )
}

export async function deleteTestRun(id: number): Promise<void> {
  const pool = getPool()
  await pool.query(`DELETE FROM test_runs WHERE id = $1`, [id])
}
