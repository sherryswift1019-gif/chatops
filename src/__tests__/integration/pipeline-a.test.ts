// src/__tests__/integration/pipeline-a.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resetTestDb } from '../helpers/db.js'

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return {
    ...actual,
    spawnSync: vi.fn(),
    spawn: vi.fn(),
    exec: vi.fn(),
    execFile: vi.fn(),
    execSync: vi.fn(),
  }
})
// 与 pipeline-a/nodes/llm-generator.ts 的 PLAYBOOK_PROMPT_TEMPLATE schema 对齐：
// playbook YAML 顶层 { specPath, scenarios }，每个 scenario 至少 1 条 acceptance。
// 必须 vi.hoisted 因为 vi.mock 工厂在 top-level 被 hoist，普通 const 还没初始化。
const { VALID_PLAYBOOK_YAML } = vi.hoisted(() => ({
  VALID_PLAYBOOK_YAML: `specPath: docs/test-specs/login.md
specTitle: login
scenarios:
  - id: login-success
    name: 登录成功跳转 dashboard
    steps:
      - "打开 /login"
      - "填写账号密码并提交"
    acceptance:
      - kind: url_match
        value: /dashboard
        timeout_ms: 5000
`,
}))

vi.mock('../../e2e/pipeline-a/llm-bridge.js', () => ({
  executeCapabilityDirectForE2e: vi.fn()
    .mockResolvedValueOnce(VALID_PLAYBOOK_YAML)
    .mockResolvedValue('{"verdict":"script_bug"}'),
}))
vi.mock('../../config/gitlab.js', () => ({
  resolveGitlabConfig: vi.fn().mockResolvedValue({ url: 'https://gitlab.example.com', token: 'tok' }),
}))

// runE2eScenario 是 host Claude → docker exec，单测里桩成"全部 acceptance 通过"。
// 同时桩 mkdtempSync 让 evidenceDir 不真落盘。
vi.mock('../../agent/e2e-scenario/runner.js', () => ({
  runE2eScenario: vi.fn().mockImplementation(async (input: any) => ({
    manifest: {
      scenarioId: input.scenarioId,
      attemptNumber: input.attemptNumber,
      result: 'pass',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 0,
      claudeTrace: [],
      acceptanceResults: [],
      artifacts: [],
    },
    rawOutput: '',
    errorMessage: null,
  })),
  __setRunnerForTesting: vi.fn(),
  __setSkillForTesting: vi.fn(),
}))

// baseline-sandbox 的 ensureWorkspaceCloned 真跑 git clone 会炸；commit-pr 用 fs.writeFileSync
// 写到不存在的目录也会炸。把 fs 写操作和 ensureWorkspaceCloned 的副作用都桩掉。
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn((path: string, ...rest: any[]) => {
      // baseline-sandbox 会读 e2e-handle-baseline.json
      if (typeof path === 'string' && path.endsWith('e2e-handle-baseline.json')) {
        return JSON.stringify({
          envId: 'test-1',
          kind: 'docker-compose-local',
          endpoints: { api: 'http://localhost:3000' },
          internalRefs: { apiPort: 3000 },
          containerId: 'chatops-e2e-3000',
          workdir: '/app',
        })
      }
      return actual.readFileSync(path as any, ...(rest as []))
    }),
    mkdtempSync: vi.fn(() => '/tmp/pipeline-a-test'),
  }
})

import { spawnSync } from 'child_process'
import { runPipelineA } from '../../e2e/pipeline-a/runner.js'
import { listE2eSpecs } from '../../db/repositories/e2e-specs.js'

beforeEach(async () => {
  await resetTestDb()
  vi.clearAllMocks()
})

describe('Pipeline A integration', () => {
  it('happy path: generate → static_check pass → baseline pass → pr_open', async () => {
    vi.mocked(spawnSync)
      // provision
      .mockReturnValueOnce({ status: 0, stdout: '{"envId":"test-1","kind":"docker-compose-local","endpoints":{},"internalRefs":{}}', stderr: '' } as any)
      // build
      .mockReturnValueOnce({ status: 0, stdout: '{}', stderr: '' } as any)
      // deploy
      .mockReturnValueOnce({ status: 0, stdout: '{}', stderr: '' } as any)
      // static_check → pass
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as any)
      // run_baseline_check → pass
      .mockReturnValueOnce({ status: 0, stdout: '{"summary":"ok"}', stderr: '' } as any)
      // git checkout -b, git add, git commit, git push
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as any)
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as any)
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as any)
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as any)
      // glab mr create
      .mockReturnValueOnce({ status: 0, stdout: 'https://gitlab.example.com/devops/chatops/-/merge_requests/1\n', stderr: '' } as any)
      // teardown
      .mockReturnValue({ status: 0, stdout: '', stderr: '' } as any)

    await runPipelineA({ targetProjectId: 'chatops', specPaths: ['docs/test-specs/login.md'], baseBranch: 'main' })

    const specs = await listE2eSpecs('chatops')
    expect(specs.some(s => s.generationStatus === 'pr_open')).toBe(true)
  })

  it('baseline fails 3 times → spec marked baseline_failed', async () => {
    vi.mocked(spawnSync)
      // provision
      .mockReturnValueOnce({ status: 0, stdout: '{"envId":"test-2","kind":"docker-compose-local","endpoints":{},"internalRefs":{}}', stderr: '' } as any)
      // build
      .mockReturnValueOnce({ status: 0, stdout: '{}', stderr: '' } as any)
      // deploy
      .mockReturnValueOnce({ status: 0, stdout: '{}', stderr: '' } as any)
      // static_check pass
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as any)
      // 3 baseline fail attempts
      .mockReturnValueOnce({ status: 1, stdout: '{"summary":"selector not found"}', stderr: '' } as any)
      .mockReturnValueOnce({ status: 1, stdout: '{"summary":"selector not found"}', stderr: '' } as any)
      .mockReturnValueOnce({ status: 1, stdout: '{"summary":"selector not found"}', stderr: '' } as any)
      // teardown
      .mockReturnValue({ status: 0, stdout: '', stderr: '' } as any)

    await runPipelineA({ targetProjectId: 'chatops', specPaths: ['docs/test-specs/login.md'], baseBranch: 'main' })

    const specs = await listE2eSpecs('chatops')
    expect(specs.some(s => s.generationStatus === 'baseline_failed')).toBe(true)
  })
})
