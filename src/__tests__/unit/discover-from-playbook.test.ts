// src/__tests__/unit/discover-from-playbook.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { PipelineBStateType } from '../../e2e/pipeline-b/types.js'

vi.mock('../../db/repositories/e2e-target-projects.js', () => ({
  getE2eTargetProject: vi.fn(),
  extractGitlabPath: vi.fn(),
}))

vi.mock('../../config/gitlab.js', () => ({
  resolveGitlabConfig: vi.fn(),
}))

vi.mock('../../e2e/pipeline-b/im-notifier.js', () => ({
  notifyRunStarted: vi.fn().mockResolvedValue(undefined),
}))

const { discoverNode } = await import('../../e2e/pipeline-b/nodes/discover.js')
const { getE2eTargetProject, extractGitlabPath } = await import('../../db/repositories/e2e-target-projects.js')
const { resolveGitlabConfig } = await import('../../config/gitlab.js')

const VALID_PLAYBOOK_YAML = `
specPath: docs/test-specs/login.md
specTitle: 用户登录
scenarios:
  - id: login.success
    name: 正确账号密码登录成功
    tags: [smoke, auth]
    acceptance:
      - kind: url_match
        value: /dashboard
  - id: login.invalid_pwd
    name: 密码错误
    tags: [auth]
    acceptance:
      - kind: dom_text_contains
        selector: .error
        value: 密码错误
`

const SECOND_PLAYBOOK_YAML = `
specPath: docs/test-specs/checkout.md
scenarios:
  - id: checkout.happy_path
    name: 顺利下单
    tags: [smoke]
    acceptance:
      - kind: url_match
        value: /order/success
`

const INVALID_YAML = `
specPath: docs/test-specs/bad.md
scenarios:
  - id: bad
    name: 缺 acceptance 字段
`

function makeState(overrides: Partial<PipelineBStateType> = {}): PipelineBStateType {
  return {
    runId: 1n,
    sandboxId: null,
    targetProjectId: 'chatops',
    sourceBranch: 'main',
    iterationBranch: '',
    scenarioFilter: null,
    sandboxHandle: null,
    projectScripts: { build: 'build.sh', deploy: 'deploy.sh', test: 'test.sh' },
    pendingScenarios: [],
    currentScenario: null,
    currentScenarioRunId: null,
    lastScenarioResult: null,
    lastFixResult: null,
    evidenceDirTemp: null,
    humanReviewDecision: null,
    currentManifest: null,
    playbooks: {},
    governorState: {
      perScenarioAttempts: {},
      totalAttempts: 0,
      runStartedAt: 0,
      totalElapsedMs: 0,
      limits: { maxPerScenarioAttempts: 3, maxRunHours: 4, maxTotalAttempts: 30, maxQueuedRuns: 2 },
    },
    summaryMrUrl: null,
    errorMessage: null,
    imContext: null,
    ...overrides,
  } as PipelineBStateType
}

describe('discoverNode (playbook-driven)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.mocked(getE2eTargetProject).mockResolvedValue({
      id: 'chatops',
      displayName: 'ChatOps',
      gitlabRepo: 'http://code.paraview.cn/g/chatops.git',
      defaultBranch: 'main',
      workingDir: '.',
      scripts: { build: 'build.sh', deploy: 'deploy.sh', test: 'test.sh' },
      capabilities: {},
      defaultSandboxKind: 'docker-compose-local',
      createdAt: new Date(),
    })
    vi.mocked(extractGitlabPath).mockReturnValue('g/chatops')
    vi.mocked(resolveGitlabConfig).mockResolvedValue({ url: 'http://code.paraview.cn', token: 't', skipTlsVerify: false })

    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
    vi.clearAllMocks()
  })

  function mockFetchPlan(plans: Array<{ url?: RegExp; status: number; body?: string | unknown[] }>): void {
    fetchSpy.mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString()
      for (const p of plans) {
        if (p.url && p.url.test(url)) {
          if (p.status === 404) return { ok: false, status: 404 } as Response
          return {
            ok: p.status >= 200 && p.status < 300,
            status: p.status,
            json: async () => p.body,
            text: async () => (typeof p.body === 'string' ? p.body : JSON.stringify(p.body)),
          } as Response
        }
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
  }

  it('拉两个 playbook，scenarios 摊平进 pendingScenarios，playbooks 按 specPath 归档', async () => {
    mockFetchPlan([
      {
        url: /repository\/tree/,
        status: 200,
        body: [
          { name: 'login.playbook.yaml', path: 'docs/test-playbooks/login.playbook.yaml', type: 'blob' },
          { name: 'checkout.playbook.yml', path: 'docs/test-playbooks/checkout.playbook.yml', type: 'blob' },
          { name: 'README.md', path: 'docs/test-playbooks/README.md', type: 'blob' }, // 非 yaml 应被过滤
        ],
      },
      { url: /login\.playbook\.yaml\/raw/, status: 200, body: VALID_PLAYBOOK_YAML },
      { url: /checkout\.playbook\.yml\/raw/, status: 200, body: SECOND_PLAYBOOK_YAML },
    ])

    const out = await discoverNode(makeState())
    expect(out.pendingScenarios).toHaveLength(3)
    expect(out.pendingScenarios?.map((s) => s.id).sort()).toEqual([
      'checkout.happy_path',
      'login.invalid_pwd',
      'login.success',
    ])
    expect(Object.keys(out.playbooks ?? {}).sort()).toEqual([
      'docs/test-playbooks/checkout.playbook.yml',
      'docs/test-playbooks/login.playbook.yaml',
    ])
  })

  it('GitLab tree 404 → 空 scenario 列表（仓库无 docs/test-playbooks）', async () => {
    mockFetchPlan([{ url: /repository\/tree/, status: 404 }])
    const out = await discoverNode(makeState())
    expect(out.pendingScenarios).toEqual([])
    expect(out.playbooks).toEqual({})
  })

  it('GitLab tree 5xx → 抛错', async () => {
    mockFetchPlan([{ url: /repository\/tree/, status: 502 }])
    await expect(discoverNode(makeState())).rejects.toThrow(/GitLab tree API 502/)
  })

  it('某 playbook YAML schema 不合法 → 跳过该文件，其它正常返回', async () => {
    mockFetchPlan([
      {
        url: /repository\/tree/,
        status: 200,
        body: [
          { name: 'good.playbook.yaml', path: 'docs/test-playbooks/good.playbook.yaml', type: 'blob' },
          { name: 'bad.playbook.yaml', path: 'docs/test-playbooks/bad.playbook.yaml', type: 'blob' },
        ],
      },
      { url: /good\.playbook\.yaml\/raw/, status: 200, body: VALID_PLAYBOOK_YAML },
      { url: /bad\.playbook\.yaml\/raw/, status: 200, body: INVALID_YAML },
    ])
    const out = await discoverNode(makeState())
    expect(out.pendingScenarios?.map((s) => s.id).sort()).toEqual(['login.invalid_pwd', 'login.success'])
    expect(Object.keys(out.playbooks ?? {})).toEqual(['docs/test-playbooks/good.playbook.yaml'])
  })

  it('scenarioFilter.ids 过滤', async () => {
    mockFetchPlan([
      {
        url: /repository\/tree/,
        status: 200,
        body: [{ name: 'p.playbook.yaml', path: 'docs/test-playbooks/p.playbook.yaml', type: 'blob' }],
      },
      { url: /raw/, status: 200, body: VALID_PLAYBOOK_YAML },
    ])
    const out = await discoverNode(makeState({ scenarioFilter: { ids: ['login.success'] } }))
    expect(out.pendingScenarios?.map((s) => s.id)).toEqual(['login.success'])
  })

  it('scenarioFilter.tags 过滤', async () => {
    mockFetchPlan([
      {
        url: /repository\/tree/,
        status: 200,
        body: [{ name: 'p.playbook.yaml', path: 'docs/test-playbooks/p.playbook.yaml', type: 'blob' }],
      },
      { url: /raw/, status: 200, body: VALID_PLAYBOOK_YAML },
    ])
    const out = await discoverNode(makeState({ scenarioFilter: { tags: ['smoke'] } }))
    expect(out.pendingScenarios?.map((s) => s.id)).toEqual(['login.success'])
  })

  it('GitLab 配置缺失 → 抛错', async () => {
    vi.mocked(resolveGitlabConfig).mockResolvedValue({ url: '', token: '', skipTlsVerify: false })
    await expect(discoverNode(makeState())).rejects.toThrow(/GitLab 配置未完成/)
  })
})
