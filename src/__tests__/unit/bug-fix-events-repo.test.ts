import { describe, it, expect, beforeEach } from 'vitest'
import { resetTestDb, getTestPool } from '../helpers/db.js'
import {
  createEvent,
  findByReport,
  findByReportCode,
  findDistinctProjects,
  findLatest,
  findPrimaryCreateIssue,
} from '../../db/repositories/bug-fix-events.js'
import { createBugAnalysisReport } from '../../db/repositories/bug-analysis-reports.js'

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

async function createReport(productLineId: number) {
  return await createBugAnalysisReport({
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
}

describe('bug-fix-events repository', () => {
  let productLineId: number

  beforeEach(async () => {
    await resetTestDb()
    productLineId = await ensureProductLine()
  })

  it('creates an event with data JSON', async () => {
    const report = await createReport(productLineId)
    const event = await createEvent({
      reportId: report.id,
      projectPath: 'PAM/pas-6.0',
      code: 'scope_identified',
      data: { sourceBranch: 'master', affectedModules: ['auth'] },
    })
    expect(event.id).toBeGreaterThan(0)
    expect(event.projectPath).toBe('PAM/pas-6.0')
    expect(event.data.sourceBranch).toBe('master')

    const all = await findByReport(report.id)
    expect(all).toHaveLength(1)
    expect(all[0].id).toBe(event.id)
  })

  it('findByReportCode filters by code', async () => {
    const report = await createReport(productLineId)
    await createEvent({ reportId: report.id, projectPath: 'PAM/a', code: 'scope_identified', data: {} })
    await createEvent({ reportId: report.id, projectPath: 'PAM/a', code: 'fix_attempt', data: {} })
    await createEvent({ reportId: report.id, projectPath: 'PAM/b', code: 'scope_identified', data: {} })

    const scopes = await findByReportCode(report.id, 'scope_identified')
    expect(scopes).toHaveLength(2)
    expect(scopes.every(e => e.code === 'scope_identified')).toBe(true)
  })

  it('findDistinctProjects returns unique non-null project_paths', async () => {
    const report = await createReport(productLineId)
    await createEvent({ reportId: report.id, projectPath: 'PAM/a', code: 'scope_identified', data: {} })
    await createEvent({ reportId: report.id, projectPath: 'PAM/a', code: 'fix_attempt', data: {} })
    await createEvent({ reportId: report.id, projectPath: 'PAM/b', code: 'scope_identified', data: {} })
    await createEvent({ reportId: report.id, projectPath: null, code: 'analysis', data: {} })

    const projects = await findDistinctProjects(report.id)
    expect(projects.sort()).toEqual(['PAM/a', 'PAM/b'])
  })

  it('findLatest returns the most recent event for a project+code', async () => {
    const report = await createReport(productLineId)
    await createEvent({ reportId: report.id, projectPath: 'PAM/a', code: 'fix_attempt', status: 'failed', data: { attempt: 1 } })
    const e2 = await createEvent({ reportId: report.id, projectPath: 'PAM/a', code: 'fix_attempt', status: 'success', data: { attempt: 2 } })

    const latest = await findLatest(report.id, 'PAM/a', 'fix_attempt')
    expect(latest?.id).toBe(e2.id)
    expect((latest?.data as { attempt: number }).attempt).toBe(2)
  })

  it('findPrimaryCreateIssue returns the create_issue event with isPrimary=true', async () => {
    const report = await createReport(productLineId)
    await createEvent({ reportId: report.id, projectPath: 'PAM/b', code: 'create_issue', data: { issueIid: 2, isPrimary: false } })
    await createEvent({ reportId: report.id, projectPath: 'PAM/a', code: 'create_issue', data: { issueIid: 1, isPrimary: true } })

    const primary = await findPrimaryCreateIssue(report.id)
    expect(primary).not.toBeNull()
    expect((primary?.data as { issueIid: number }).issueIid).toBe(1)
  })
})
