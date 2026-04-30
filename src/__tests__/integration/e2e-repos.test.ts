import { describe, it, expect, beforeEach } from 'vitest'
import { resetTestDb } from '../helpers/db.js'
import { listE2eTargetProjects, getE2eTargetProject } from '../../db/repositories/e2e-target-projects.js'
import { upsertE2eSpec, updateE2eSpecStatus, listE2eSpecs } from '../../db/repositories/e2e-specs.js'
import { createE2eRun, getE2eRun, updateE2eRunStatus } from '../../db/repositories/e2e-runs.js'
import { createScenarioRun, finishScenarioRun, getLatestAttemptNumber } from '../../db/repositories/e2e-scenario-runs.js'
import { createSandbox, updateSandboxStatus, getSandboxByRunId } from '../../db/repositories/e2e-sandboxes.js'

beforeEach(async () => { await resetTestDb() })

describe('e2e-target-projects repo', () => {
  it('chatops project is seeded', async () => {
    const projects = await listE2eTargetProjects()
    expect(projects).toHaveLength(1)
    expect(projects[0].id).toBe('chatops')
    expect(projects[0].scripts.deploy).toBe('deploy.sh')
  })

  it('getE2eTargetProject returns null for unknown id', async () => {
    expect(await getE2eTargetProject('unknown')).toBeNull()
  })
})

describe('e2e-specs repo', () => {
  it('upsertE2eSpec creates and updates', async () => {
    const spec = await upsertE2eSpec({ targetProjectId: 'chatops', specPath: 'docs/test-specs/login.md', title: 'Login', contentHash: 'abc123' })
    expect(spec.generationStatus).toBe('pending')

    await updateE2eSpecStatus(spec.id, 'generating')
    const all = await listE2eSpecs('chatops')
    expect(all[0].generationStatus).toBe('generating')
  })
})

describe('e2e-runs + scenario-runs repo', () => {
  it('creates run and scenario run, updates status', async () => {
    const run = await createE2eRun({ targetProjectId: 'chatops', triggerType: 'manual', triggerActor: 'test', sourceBranch: 'main', iterationBranch: 'test-iter/1', scenarioFilter: null })
    expect(run.status).toBe('pending')

    await updateE2eRunStatus(run.id, 'running')
    const fetched = await getE2eRun(run.id)
    expect(fetched?.status).toBe('running')

    const sr = await createScenarioRun({ e2eRunId: run.id, scenarioId: 'login-success', scenarioName: 'Login success', attemptNumber: 1 })
    await finishScenarioRun(sr.id, 'pass', { durationMs: 1500 })

    const nextAttempt = await getLatestAttemptNumber(run.id, 'login-success')
    expect(nextAttempt).toBe(1)
  })
})

describe('e2e-sandboxes repo', () => {
  it('creates sandbox and updates status', async () => {
    const run = await createE2eRun({ targetProjectId: 'chatops', triggerType: 'test', triggerActor: null, sourceBranch: 'main', iterationBranch: 'test-iter/2', scenarioFilter: null })
    const sandbox = await createSandbox({ e2eRunId: run.id, kind: 'docker-compose-local', handle: { envId: 'e2e-42', kind: 'docker-compose-local', endpoints: { api: 'http://localhost:13001' } } })
    expect(sandbox.status).toBe('provisioning')

    await updateSandboxStatus(sandbox.id, 'ready', { readyAt: new Date() })
    const fetched = await getSandboxByRunId(run.id)
    expect(fetched?.status).toBe('ready')
  })
})
