import { describe, it, expect, beforeEach } from 'vitest'
import { resetTestDb, getTestPool } from '../helpers/db.js'
import { listE2eTargetProjects, getE2eTargetProject } from '../../db/repositories/e2e-target-projects.js'
import { upsertE2eSpec, updateE2eSpecStatus, listE2eSpecs } from '../../db/repositories/e2e-specs.js'
import { createE2eRun, getE2eRun, updateE2eRunStatus } from '../../db/repositories/e2e-runs.js'
import { createScenarioRun, finishScenarioRun, getLatestAttemptNumber, mergeEvidenceManifest, listScenarioRuns } from '../../db/repositories/e2e-scenario-runs.js'
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

describe('mergeEvidenceManifest + finishScenarioRun 增量更新语义', () => {
  // 这组测试守门 evidence_manifest 字段的「累加 vs 覆盖」契约：
  //   - finishScenarioRun 不传 evidenceManifest → 字段保留旧值（COALESCE 行为）
  //   - mergeEvidenceManifest → jsonb || 浅 merge，保留原 key + 加新 key + 同 key 取新
  // 历史 bug：mark-unfixable.ts 用 finishScenarioRun({evidenceManifest: {aiDiagnosis}}) 整体覆盖，
  // 把 host Claude 写入的 acceptanceResults / claudeTrace / artifacts 全洗掉。
  async function newScenarioRunId(scenarioId: string): Promise<bigint> {
    const run = await createE2eRun({
      targetProjectId: 'chatops', triggerType: 'manual', triggerActor: null,
      sourceBranch: 'main', iterationBranch: `test-iter/${scenarioId}`, scenarioFilter: null,
    })
    const sr = await createScenarioRun({ e2eRunId: run.id, scenarioId, scenarioName: scenarioId, attemptNumber: 1 })
    return sr.id
  }

  async function readManifest(srId: bigint): Promise<Record<string, unknown> | null> {
    const { rows } = await getTestPool().query(
      `SELECT evidence_manifest FROM e2e_scenario_runs WHERE id = $1`,
      [srId],
    )
    return rows[0]?.evidence_manifest ?? null
  }

  it('mergeEvidenceManifest 在 NULL 字段上 → 字段值 = partial', async () => {
    const id = await newScenarioRunId('merge-on-null')
    await mergeEvidenceManifest(id, { aiDiagnosis: { verdict: 'uncertain', success: false } })
    const got = await readManifest(id)
    expect(got).toEqual({ aiDiagnosis: { verdict: 'uncertain', success: false } })
  })

  it('mergeEvidenceManifest 保留原 key + 加新 key', async () => {
    const id = await newScenarioRunId('merge-add-key')
    await finishScenarioRun(id, 'fail', { evidenceManifest: { acceptanceResults: [{ kind: 'url_match', result: 'fail' }], claudeTrace: ['step1'] } })
    await mergeEvidenceManifest(id, { aiDiagnosis: { verdict: 'script_bug', success: false } })
    const got = await readManifest(id) as Record<string, unknown>
    expect(got).toMatchObject({
      acceptanceResults: [{ kind: 'url_match', result: 'fail' }],
      claudeTrace: ['step1'],
      aiDiagnosis: { verdict: 'script_bug', success: false },
    })
  })

  it('mergeEvidenceManifest 同 key 取新值', async () => {
    const id = await newScenarioRunId('merge-overwrite-key')
    await finishScenarioRun(id, 'fail', { evidenceManifest: { x: 1, y: 2 } })
    await mergeEvidenceManifest(id, { x: 99 })
    const got = await readManifest(id) as Record<string, unknown>
    expect(got).toEqual({ x: 99, y: 2 })
  })

  it('finishScenarioRun 不传 evidenceManifest → 既有字段保留', async () => {
    const id = await newScenarioRunId('finish-no-manifest')
    await finishScenarioRun(id, 'fail', { evidenceManifest: { foo: 'bar' } })
    await finishScenarioRun(id, 'unfixable')   // 仅改 result，不传 evidenceManifest
    const got = await readManifest(id)
    expect(got).toEqual({ foo: 'bar' })

    const { rows } = await getTestPool().query(`SELECT result FROM e2e_scenario_runs WHERE id = $1`, [id])
    expect(rows[0].result).toBe('unfixable')
  })

  it('完整路径：写完整 manifest → mergeEvidenceManifest 加 aiDiagnosis → 两者共存', async () => {
    // 复现实际 bug 场景：host Claude 写完整 manifest → fix-loop 耗尽 → markUnfixable 应当 merge 不覆盖
    const id = await newScenarioRunId('end-to-end-path')
    const fullManifest = {
      scenarioId: 'login', result: 'fail', durationMs: 68000,
      acceptanceResults: [{ kind: 'url_match', expected: '/product-lines', actual: '/login', reason: '401 invalid_credentials' }],
      claudeTrace: [{ step: 1, intent: 'navigate', verdict: 'ok' }, { step: 5, intent: 'click login', verdict: 'error' }],
      artifacts: [{ kind: 'screenshot', path: 'login-fail.png' }],
    }
    await finishScenarioRun(id, 'fail', { evidenceManifest: fullManifest })
    await finishScenarioRun(id, 'unfixable')   // mark-unfixable 第一步：仅改 result
    await mergeEvidenceManifest(id, { aiDiagnosis: { verdict: 'uncertain', success: false, rootCauseSummary: 'max attempts' } })

    const got = await readManifest(id) as Record<string, unknown>
    expect(got).toMatchObject({
      acceptanceResults: fullManifest.acceptanceResults,
      claudeTrace: fullManifest.claudeTrace,
      artifacts: fullManifest.artifacts,
      durationMs: 68000,
      aiDiagnosis: { verdict: 'uncertain', success: false, rootCauseSummary: 'max attempts' },
    })
    const runs = await listScenarioRuns(got ? (await getTestPool().query(`SELECT e2e_run_id FROM e2e_scenario_runs WHERE id=$1`, [id])).rows[0].e2e_run_id : 0n)
    expect(runs[0].result).toBe('unfixable')
  })
})
