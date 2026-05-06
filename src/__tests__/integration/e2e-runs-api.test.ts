// src/__tests__/integration/e2e-runs-api.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { resetTestDb } from '../helpers/db.js'
import { buildAdminTestApp } from '../helpers/admin-app.js'
import { registerE2eRunRoutes } from '../../admin/routes/e2e-runs.js'
import { createE2eRun, getE2eRun } from '../../db/repositories/e2e-runs.js'
import { getPool } from '../../db/client.js'
import type { FastifyInstance } from 'fastify'

vi.mock('../../e2e/pipeline-b/runner.js', () => ({
  runPipelineB: vi.fn().mockResolvedValue({ runId: 1n, status: 'pending' }),
}))

vi.mock('../../e2e/pipeline-b/playbook/load-from-gitlab.js', () => ({
  loadScenariosFromGitlab: vi.fn().mockResolvedValue({
    ref: 'main',
    playbooks: {},
    scenarios: [
      { id: 'login.success', name: '登录成功', tags: ['smoke', 'auth'], specPath: 'docs/test-playbooks/login.yaml' },
      { id: 'checkout.happy_path', name: '顺利下单', tags: ['smoke'], specPath: 'docs/test-playbooks/checkout.yaml' },
    ],
  }),
}))

async function buildApp(): Promise<FastifyInstance> {
  return buildAdminTestApp(async (app) => {
    await registerE2eRunRoutes(app)
  })
}

beforeEach(async () => {
  await resetTestDb()
  vi.clearAllMocks()
  const { loadScenariosFromGitlab } = await import('../../e2e/pipeline-b/playbook/load-from-gitlab.js')
  vi.mocked(loadScenariosFromGitlab).mockResolvedValue({
    ref: 'main',
    playbooks: {},
    scenarios: [
      { id: 'login.success', name: '登录成功', tags: ['smoke', 'auth'], specPath: 'docs/test-playbooks/login.yaml' },
      { id: 'checkout.happy_path', name: '顺利下单', tags: ['smoke'], specPath: 'docs/test-playbooks/checkout.yaml' },
    ],
  })
})

describe('GET /e2e-runs', () => {
  it('returns empty list when no runs', async () => {
    const app = await buildApp()
    const r = await app.inject({ method: 'GET', url: '/e2e-runs' })
    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(body.runs).toEqual([])
    expect(body.total).toBe(0)
    await app.close()
  })

  it('returns runs with total count', async () => {
    await createE2eRun({ targetProjectId: 'chatops', triggerType: 'manual', triggerActor: 'alice', sourceBranch: 'main', iterationBranch: 'e2e/iter-1', scenarioFilter: null })
    await createE2eRun({ targetProjectId: 'chatops', triggerType: 'api', triggerActor: null, sourceBranch: 'main', iterationBranch: 'e2e/iter-2', scenarioFilter: null })
    const app = await buildApp()
    const r = await app.inject({ method: 'GET', url: '/e2e-runs' })
    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(body.runs).toHaveLength(2)
    expect(body.total).toBe(2)
    expect(typeof body.runs[0].id).toBe('string')
    await app.close()
  })

  it('filters by projectId', async () => {
    await getPool().query(
      `INSERT INTO e2e_target_projects (id, display_name, gitlab_repo, default_branch, scripts) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
      ['other-project', 'Other Project', 'devops/other', 'main', JSON.stringify({ build: 'build.sh', deploy: 'deploy.sh', test: 'test.sh' })],
    )
    await createE2eRun({ targetProjectId: 'chatops', triggerType: 'manual', triggerActor: null, sourceBranch: 'main', iterationBranch: 'e2e/iter-1', scenarioFilter: null })
    await createE2eRun({ targetProjectId: 'other-project', triggerType: 'manual', triggerActor: null, sourceBranch: 'main', iterationBranch: 'e2e/iter-2', scenarioFilter: null })
    const app = await buildApp()
    const r = await app.inject({ method: 'GET', url: '/e2e-runs?projectId=chatops' })
    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(body.runs).toHaveLength(1)
    expect(body.total).toBe(1)
    expect(body.runs[0].targetProjectId).toBe('chatops')
    await app.close()
  })

  it('respects limit and offset', async () => {
    for (let i = 0; i < 5; i++) {
      await createE2eRun({ targetProjectId: 'chatops', triggerType: 'manual', triggerActor: null, sourceBranch: 'main', iterationBranch: `e2e/iter-${i}`, scenarioFilter: null })
    }
    const app = await buildApp()
    const r = await app.inject({ method: 'GET', url: '/e2e-runs?limit=2&offset=2' })
    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(body.runs).toHaveLength(2)
    expect(body.total).toBe(5)
    await app.close()
  })
})

describe('GET /e2e-runs/:runId', () => {
  it('returns 404 for unknown id', async () => {
    const app = await buildApp()
    const r = await app.inject({ method: 'GET', url: '/e2e-runs/99999' })
    expect(r.statusCode).toBe(404)
    await app.close()
  })

  it('returns run with sandbox and scenarioRuns', async () => {
    const run = await createE2eRun({ targetProjectId: 'chatops', triggerType: 'manual', triggerActor: 'bob', sourceBranch: 'main', iterationBranch: 'e2e/iter-1', scenarioFilter: null })
    const app = await buildApp()
    const r = await app.inject({ method: 'GET', url: `/e2e-runs/${run.id.toString()}` })
    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(body.run.id).toBe(run.id.toString())
    expect(body.run.targetProjectId).toBe('chatops')
    expect(body.sandbox).toBeNull()
    expect(body.scenarioRuns).toEqual([])
    expect(body.playbookDraft).toBeNull()
    await app.close()
  })

  it('returns playbookDraft=null when run has no linked draft', async () => {
    const run = await createE2eRun({ targetProjectId: 'chatops', triggerType: 'api', triggerActor: null, sourceBranch: 'main', iterationBranch: '', scenarioFilter: null })
    const app = await buildApp()
    const r = await app.inject({ method: 'GET', url: `/e2e-runs/${run.id.toString()}` })
    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(body.playbookDraft).toBeNull()
    await app.close()
  })

  it('returns playbookDraft summary with mrUrl when run has linked draft', async () => {
    const run = await createE2eRun({ targetProjectId: 'chatops', triggerType: 'manual_draft', triggerActor: null, sourceBranch: 'main', iterationBranch: '', scenarioFilter: null })
    const draftIns = await getPool().query<{ id: string }>(
      `INSERT INTO e2e_playbook_drafts (target_project_id, scenario_input, yaml_content, status, e2e_run_id, mr_url, committed_path)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        'chatops',
        '测试登录页',
        'scenarios: []',
        'approved',
        run.id,
        'http://code.paraview.cn/foo/-/merge_requests/42',
        'docs/test-playbooks/draft-1.playbook.yaml',
      ],
    )
    const draftId = draftIns.rows[0].id
    const app = await buildApp()
    const r = await app.inject({ method: 'GET', url: `/e2e-runs/${run.id.toString()}` })
    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(body.playbookDraft).toEqual({
      id: draftId.toString(),
      status: 'approved',
      mrUrl: 'http://code.paraview.cn/foo/-/merge_requests/42',
      committedPath: 'docs/test-playbooks/draft-1.playbook.yaml',
    })
    await app.close()
  })
})

describe('GET /e2e-runs/scenario-options', () => {
  it('returns 400 when projectId missing', async () => {
    const app = await buildApp()
    const r = await app.inject({ method: 'GET', url: '/e2e-runs/scenario-options' })
    expect(r.statusCode).toBe(400)
    expect(r.json()).toEqual({ error: 'projectId required' })
    await app.close()
  })

  it('loads scenarios and de-duplicated tags for selected ref', async () => {
    const { loadScenariosFromGitlab } = await import('../../e2e/pipeline-b/playbook/load-from-gitlab.js')
    const app = await buildApp()
    const r = await app.inject({ method: 'GET', url: '/e2e-runs/scenario-options?projectId=chatops&ref=feature%2Fsmoke' })
    expect(r.statusCode).toBe(200)
    expect(loadScenariosFromGitlab).toHaveBeenCalledWith('chatops', 'feature/smoke')
    expect(r.json()).toEqual({
      ref: 'main',
      allTags: ['auth', 'smoke'],
      scenarios: [
        { id: 'login.success', name: '登录成功', tags: ['smoke', 'auth'], specPath: 'docs/test-playbooks/login.yaml' },
        { id: 'checkout.happy_path', name: '顺利下单', tags: ['smoke'], specPath: 'docs/test-playbooks/checkout.yaml' },
      ],
    })
    await app.close()
  })

  it('returns 502 when GitLab playbook loading fails', async () => {
    const { loadScenariosFromGitlab } = await import('../../e2e/pipeline-b/playbook/load-from-gitlab.js')
    vi.mocked(loadScenariosFromGitlab).mockRejectedValueOnce(new Error('GitLab timeout'))
    const app = await buildApp()
    const r = await app.inject({ method: 'GET', url: '/e2e-runs/scenario-options?projectId=chatops' })
    expect(r.statusCode).toBe(502)
    expect(r.json()).toEqual({
      error: 'gitlab_unavailable',
      message: 'GitLab timeout',
    })
    await app.close()
  })
})

describe('POST /e2e-runs', () => {
  it('returns 400 when targetProjectId missing', async () => {
    const app = await buildApp()
    const r = await app.inject({
      method: 'POST',
      url: '/e2e-runs',
      payload: {},
    })
    expect(r.statusCode).toBe(400)
    await app.close()
  })

  it('returns 202 and fires runPipelineB', async () => {
    const { runPipelineB } = await import('../../e2e/pipeline-b/runner.js')
    const app = await buildApp()
    const r = await app.inject({
      method: 'POST',
      url: '/e2e-runs',
      payload: { targetProjectId: 'chatops', sourceBranch: 'feature/x' },
    })
    expect(r.statusCode).toBe(202)
    const body = r.json()
    expect(body.runId).toBe('1')
    expect(body.status).toBe('pending')
    expect(runPipelineB).toHaveBeenCalledWith(expect.objectContaining({
      targetProjectId: 'chatops',
      sourceBranch: 'feature/x',
      triggerType: 'api',
    }))
    await app.close()
  })

  it('defaults sourceBranch to main', async () => {
    const { runPipelineB } = await import('../../e2e/pipeline-b/runner.js')
    const app = await buildApp()
    await app.inject({
      method: 'POST',
      url: '/e2e-runs',
      payload: { targetProjectId: 'chatops' },
    })
    expect(runPipelineB).toHaveBeenCalledWith(expect.objectContaining({ sourceBranch: 'main' }))
    await app.close()
  })

  it('persists default governorState (含 limits) into DB', async () => {
    const app = await buildApp()
    const r = await app.inject({
      method: 'POST',
      url: '/e2e-runs',
      payload: { targetProjectId: 'chatops' },
    })
    expect(r.statusCode).toBe(202)
    const body = r.json()
    const run = await getE2eRun(BigInt(body.runId))
    expect(run).not.toBeNull()
    const gs = run!.governorState as { limits?: Record<string, number>; totalAttempts?: number; runStartedAt?: number }
    expect(gs.limits).toBeDefined()
    expect(gs.limits!.maxTotalAttempts).toBe(30)
    expect(gs.limits!.maxRunHours).toBe(4)
    expect(gs.limits!.maxPerScenarioAttempts).toBe(3)
    expect(gs.totalAttempts).toBe(0)
    expect(typeof gs.runStartedAt).toBe('number')
    await app.close()
  })

  it('persists governorOverrides into DB.governor_state.limits', async () => {
    const app = await buildApp()
    const r = await app.inject({
      method: 'POST',
      url: '/e2e-runs',
      payload: {
        targetProjectId: 'chatops',
        governorOverrides: { maxRunHours: 2, maxTotalAttempts: 10 },
      },
    })
    expect(r.statusCode).toBe(202)
    const body = r.json()
    const run = await getE2eRun(BigInt(body.runId))
    const gs = run!.governorState as { limits?: Record<string, number> }
    expect(gs.limits!.maxRunHours).toBe(2)
    expect(gs.limits!.maxTotalAttempts).toBe(10)
    expect(gs.limits!.maxPerScenarioAttempts).toBe(3)
    await app.close()
  })

  it('persists and starts a smoke-tag filtered run', async () => {
    const { runPipelineB } = await import('../../e2e/pipeline-b/runner.js')
    const app = await buildApp()
    const r = await app.inject({
      method: 'POST',
      url: '/e2e-runs',
      payload: {
        targetProjectId: 'chatops',
        sourceBranch: 'main',
        scenarioFilter: { tags: ['smoke'] },
      },
    })
    expect(r.statusCode).toBe(202)
    const body = r.json()
    const run = await getE2eRun(BigInt(body.runId))
    expect(run?.scenarioFilter).toEqual({ tags: ['smoke'] })
    expect(runPipelineB).toHaveBeenCalledWith(expect.objectContaining({
      targetProjectId: 'chatops',
      sourceBranch: 'main',
      scenarioFilter: { tags: ['smoke'] },
    }))
    await app.close()
  })

  it('returns 429 when queued runs >= maxQueuedRuns (don\'t leave orphan pending row)', async () => {
    // 预先建 2 个 running run（达到 maxQueuedRuns 上限 = 2）
    await createE2eRun({
      targetProjectId: 'chatops', triggerType: 'manual', triggerActor: null,
      sourceBranch: 'main', iterationBranch: 'iter-1', scenarioFilter: null,
    })
    await createE2eRun({
      targetProjectId: 'chatops', triggerType: 'manual', triggerActor: null,
      sourceBranch: 'main', iterationBranch: 'iter-2', scenarioFilter: null,
    })
    await getPool().query(`UPDATE e2e_runs SET status='running' WHERE iteration_branch IN ('iter-1','iter-2')`)

    const beforeCount = (await getPool().query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM e2e_runs`)).rows[0].n

    const app = await buildApp()
    const r = await app.inject({
      method: 'POST',
      url: '/e2e-runs',
      payload: { targetProjectId: 'chatops' },
    })

    expect(r.statusCode).toBe(429)
    const body = r.json()
    expect(body.error).toBe('too_many_queued_runs')
    expect(body.queued).toBe(2)
    expect(body.limit).toBe(2)

    // 关键：429 时不应该 createE2eRun 留下孤儿 row
    const afterCount = (await getPool().query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM e2e_runs`)).rows[0].n
    expect(afterCount).toBe(beforeCount)

    await app.close()
  })
})

describe('POST /e2e-runs/:runId/abort', () => {
  it('returns 404 for unknown runId', async () => {
    const app = await buildApp()
    const r = await app.inject({
      method: 'POST',
      url: '/e2e-runs/99999/abort',
      payload: {},
    })
    expect(r.statusCode).toBe(404)
    await app.close()
  })

  it('updates run status to aborted with default reason', async () => {
    const run = await createE2eRun({ targetProjectId: 'chatops', triggerType: 'manual', triggerActor: null, sourceBranch: 'main', iterationBranch: 'e2e/iter-1', scenarioFilter: null })
    const app = await buildApp()
    const r = await app.inject({
      method: 'POST',
      url: `/e2e-runs/${run.id.toString()}/abort`,
      payload: {},
    })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ ok: true })
    const updated = await getE2eRun(run.id)
    expect(updated?.status).toBe('aborted')
    expect(updated?.abortReason).toBe('user_abort')
    expect(updated?.finishedAt).not.toBeNull()
    await app.close()
  })

  it('uses custom abort reason when provided', async () => {
    const run = await createE2eRun({ targetProjectId: 'chatops', triggerType: 'manual', triggerActor: null, sourceBranch: 'main', iterationBranch: 'e2e/iter-2', scenarioFilter: null })
    const app = await buildApp()
    await app.inject({
      method: 'POST',
      url: `/e2e-runs/${run.id.toString()}/abort`,
      payload: { reason: 'timeout_exceeded' },
    })
    const updated = await getE2eRun(run.id)
    expect(updated?.abortReason).toBe('timeout_exceeded')
    await app.close()
  })
})
