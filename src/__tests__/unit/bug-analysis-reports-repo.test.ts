import { describe, it, expect, beforeEach } from 'vitest'
import { resetTestDb, getTestPool } from '../helpers/db.js'
import {
  createBugAnalysisReport,
  getBugAnalysisReportById,
  setPipelineRunId,
  updateReportStatus,
} from '../../db/repositories/bug-analysis-reports.js'

async function ensureProductLine(): Promise<number> {
  const pool = getTestPool()
  const { rows } = await pool.query(
    `INSERT INTO product_lines (name, display_name, description)
     VALUES ('pam', 'PAM', 'test')
     ON CONFLICT (name) DO NOTHING RETURNING id`,
  )
  if (rows[0]?.id) return rows[0].id as number
  const fallback = await pool.query(`SELECT id FROM product_lines WHERE name = 'pam'`)
  return fallback.rows[0].id as number
}

async function seedTestRun(productLineId: number): Promise<number> {
  const pool = getTestPool()
  const pipe = await pool.query(
    `INSERT INTO test_pipelines (product_line_id, name, description, stages, enabled)
     VALUES ($1, 'test-pipeline', '', '[]'::jsonb, true) RETURNING id`,
    [productLineId],
  )
  const run = await pool.query(
    `INSERT INTO test_runs (pipeline_id, trigger_type, triggered_by, status)
     VALUES ($1, 'api', 'test', 'success') RETURNING id`,
    [pipe.rows[0].id],
  )
  return run.rows[0].id as number
}

describe('bug-analysis-reports extension', () => {
  let productLineId: number

  beforeEach(async () => {
    await resetTestDb()
    productLineId = await ensureProductLine()
  })

  it('setPipelineRunId writes pipeline_run_id', async () => {
    const report = await createBugAnalysisReport({
      issueId: 1,
      issueUrl: 'http://x',
      productLineId,
      agentSessionId: null,
      level: 'l2',
      classification: 'bug',
      confidence: 'high',
      confidenceScore: 0.9,
      rootCauseSummary: '',
      solutionsJson: [],
      affectedModules: null,
      analysisSteps: null,
      metadata: null,
    })

    const runId = await seedTestRun(productLineId)
    await setPipelineRunId(report.id, runId)

    const reloaded = await getBugAnalysisReportById(report.id)
    expect(reloaded?.pipelineRunId).toBe(runId)
  })

  it('primaryProjectPath round-trips through create + get', async () => {
    const report = await createBugAnalysisReport({
      issueId: 2,
      issueUrl: 'http://y',
      productLineId,
      agentSessionId: null,
      level: 'l3',
      classification: 'bug',
      confidence: 'high',
      confidenceScore: 0.8,
      rootCauseSummary: '',
      solutionsJson: [],
      affectedModules: null,
      analysisSteps: null,
      metadata: null,
      primaryProjectPath: 'PAM/pas-6.0',
    })
    const reloaded = await getBugAnalysisReportById(report.id)
    expect(reloaded?.primaryProjectPath).toBe('PAM/pas-6.0')
    expect(reloaded?.pipelineRunId).toBeNull()
  })

  it('updateReportStatus accepts new pipeline_success status', async () => {
    const report = await createBugAnalysisReport({
      issueId: 3,
      issueUrl: 'http://z',
      productLineId,
      agentSessionId: null,
      level: 'l1',
      classification: 'config_issue',
      confidence: 'high',
      confidenceScore: 0.95,
      rootCauseSummary: '',
      solutionsJson: [],
      affectedModules: null,
      analysisSteps: null,
      metadata: null,
    })

    const updated = await updateReportStatus(report.id, 'pipeline_success')
    expect(updated?.status).toBe('pipeline_success')
  })
})

describe('bug-analysis-reports repository — completed_at', () => {
  beforeEach(async () => {
    await resetTestDb()
    await getTestPool().query(`INSERT INTO product_lines (name, display_name) VALUES ('pam','PAM')`)
  })

  it('终态状态 (completed) 触发 completed_at 写入', async () => {
    const r = await createBugAnalysisReport({
      issueId: 1, issueUrl: 'x', productLineId: 1, level: 'l2',
      classification: 'bug', confidence: 'high',
      solutionsJson: [], status: 'draft',
    } as any)
    await updateReportStatus(r.id, 'completed')
    const fresh = await getBugAnalysisReportById(r.id)
    expect(fresh!.completedAt).toBeInstanceOf(Date)
  })

  it('终态状态 (aborted) 也触发写入', async () => {
    const r = await createBugAnalysisReport({
      issueId: 2, issueUrl: 'x', productLineId: 1, level: 'l2',
      classification: 'bug', confidence: 'high',
      solutionsJson: [], status: 'draft',
    } as any)
    await updateReportStatus(r.id, 'aborted')
    const fresh = await getBugAnalysisReportById(r.id)
    expect(fresh!.completedAt).toBeInstanceOf(Date)
  })

  it('终态状态 (pending_manual) 也触发写入', async () => {
    const r = await createBugAnalysisReport({
      issueId: 3, issueUrl: 'x', productLineId: 1, level: 'l2',
      classification: 'bug', confidence: 'high',
      solutionsJson: [], status: 'draft',
    } as any)
    await updateReportStatus(r.id, 'pending_manual')
    const fresh = await getBugAnalysisReportById(r.id)
    expect(fresh!.completedAt).toBeInstanceOf(Date)
  })

  // 注：pipeline_success 自 ec67276 起被视为终态（"当前轮次已结束"语义），
  // 与 completed/aborted/pending_manual 并列触发 completed_at 写入。
  it('终态状态 (pipeline_success) 也触发写入', async () => {
    const r = await createBugAnalysisReport({
      issueId: 6, issueUrl: 'x', productLineId: 1, level: 'l2',
      classification: 'bug', confidence: 'high',
      solutionsJson: [], status: 'draft',
    } as any)
    await updateReportStatus(r.id, 'pipeline_success')
    const fresh = await getBugAnalysisReportById(r.id)
    expect(fresh!.completedAt).toBeInstanceOf(Date)
  })

  it('非终态 (published) 不写 completed_at', async () => {
    const r = await createBugAnalysisReport({
      issueId: 4, issueUrl: 'x', productLineId: 1, level: 'l2',
      classification: 'bug', confidence: 'high',
      solutionsJson: [], status: 'draft',
    } as any)
    await updateReportStatus(r.id, 'published')
    const fresh = await getBugAnalysisReportById(r.id)
    expect(fresh!.completedAt).toBeNull()
  })

  it('幂等：已有 completed_at 不被二次写入覆盖', async () => {
    const r = await createBugAnalysisReport({
      issueId: 5, issueUrl: 'x', productLineId: 1, level: 'l2',
      classification: 'bug', confidence: 'high',
      solutionsJson: [], status: 'draft',
    } as any)
    await updateReportStatus(r.id, 'completed')
    const firstCompleteAt = (await getBugAnalysisReportById(r.id))!.completedAt!

    await new Promise(res => setTimeout(res, 50))
    await updateReportStatus(r.id, 'completed')
    const secondCompleteAt = (await getBugAnalysisReportById(r.id))!.completedAt!

    expect(secondCompleteAt.getTime()).toBe(firstCompleteAt.getTime())
  })
})
