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
