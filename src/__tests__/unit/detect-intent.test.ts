/**
 * 单元测试：detectIntent 的幻觉 key 防御
 *
 * 验证：当 LLM 返回一个不在 im_triggers 列表里的 capability key 时，
 * detectIntent 应返回 null，而不是把幻觉 key 传给下游。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── hoisted mock refs ────────────────────────────────────────────────────────
const mockPorygonRun = vi.hoisted(() => vi.fn<() => Promise<string>>())
const mockListIMTriggers = vi.hoisted(() => vi.fn())

// ─── mocks ────────────────────────────────────────────────────────────────────

vi.mock('@snack-kit/porygon', () => ({
  createPorygon: vi.fn(() => ({ run: mockPorygonRun, query: vi.fn() })),
}))

vi.mock('../../db/repositories/im-triggers.js', () => ({
  listIMTriggers: mockListIMTriggers,
  getIMTrigger: vi.fn(async () => null),
}))

vi.mock('../../db/repositories/system-config.js', () => ({
  getConfig: vi.fn(async () => null),
}))

vi.mock('../../agent/claude-config.js', () => ({
  buildClaudeEnv: vi.fn(async () => ({})),
}))

// 其余 DB/副作用依赖的 no-op mock
vi.mock('../../db/repositories/capabilities.js', () => ({ getCapabilityByKey: vi.fn(), listCapabilities: vi.fn() }))
vi.mock('../../db/repositories/tasks.js', () => ({ getRecentTasks: vi.fn(async () => []) }))
vi.mock('../../db/repositories/product-line-im-triggers.js', () => ({ checkIMTriggerAccess: vi.fn(), listProductLineIMTriggers: vi.fn(async () => []) }))
vi.mock('../../db/repositories/product-lines.js', () => ({ getProductLineById: vi.fn() }))
vi.mock('../../db/repositories/projects-repo.js', () => ({ listProjects: vi.fn(async () => []) }))
vi.mock('../../db/repositories/test-servers.js', () => ({ listTestServers: vi.fn(async () => []) }))
vi.mock('../../db/repositories/product-line-envs.js', () => ({ listProductLineEnvs: vi.fn(async () => []) }))
vi.mock('../../db/repositories/environments-repo.js', () => ({ listEnvironments: vi.fn(async () => []) }))
vi.mock('../../db/repositories/approval-rules.js', () => ({ getApprovalRules: vi.fn(async () => []) }))
vi.mock('../../db/repositories/product-knowledge-repos.js', () => ({ getByProductLineId: vi.fn(async () => []) }))
vi.mock('../../db/repositories/prd-documents.js', () => ({ getPrdDocumentById: vi.fn() }))
vi.mock('../../agent/coordinator.js', () => ({ triggerCapability: vi.fn(), maybeCompleteAnalyze: vi.fn() }))
vi.mock('../../approval/router.js', () => ({ ApprovalRouter: vi.fn(() => ({})) }))
vi.mock('../../agent/deploy-lock.js', () => ({ acquireLock: vi.fn(), releaseLock: vi.fn() }))
vi.mock('../../agent/worktree/manager.js', () => ({ acquire: vi.fn(), release: vi.fn() }))
vi.mock('../../agent/prd/reject-seed.js', () => ({ buildRejectSystemPromptAppendix: vi.fn(async () => '') }))
vi.mock('../../agent/runner-greet-filter.js', () => ({ filterImTriggerableTriggers: vi.fn(() => []) }))
vi.mock('../../agent/tools/index.js', () => ({ getTool: vi.fn(), getAllTools: vi.fn(() => []), getPermittedTools: vi.fn(() => []) }))

// ─── 测试 ─────────────────────────────────────────────────────────────────────

function makeTrigger(key: string, enabled = true) {
  return {
    id: 0, key, displayName: key, description: '',
    pipelineId: null, capabilityKey: null, intentHints: '',
    examples: [], failureMessages: {}, defaultApprovalRuleId: null,
    isSystem: false, enabled,
    createdAt: new Date(), updatedAt: new Date(),
  }
}

describe('detectIntent — 幻觉 key 防御', () => {
  let detectIntent: (prompt: string) => Promise<unknown>

  beforeEach(async () => {
    vi.clearAllMocks()
    mockListIMTriggers.mockResolvedValue([
      makeTrigger('deploy'),
      makeTrigger('rollback'),
      makeTrigger('view_deployments'),
    ])
    const { ClaudeRunner } = await import('../../agent/claude-runner.js')
    const runner = new ClaudeRunner()
    detectIntent = (prompt: string) => (runner as any).detectIntent(prompt)
  })

  it('LLM 返回列表外的幻觉 key → 返回 null', async () => {
    mockPorygonRun.mockResolvedValueOnce(
      JSON.stringify({ capability: 'deploy_env_pam', summary: '部署PAM环境' })
    )
    const result = await detectIntent('部署PAM环境')
    expect(result).toBeNull()
  })

  it('LLM 返回列表内的合法 key → 返回意图', async () => {
    mockPorygonRun.mockResolvedValueOnce(
      JSON.stringify({ capability: 'deploy', project: 'pam', env: 'staging', summary: '部署pam到staging' })
    )
    const result = await detectIntent('部署pam到staging')
    expect(result).toMatchObject({ capability: 'deploy' })
  })

  it('LLM 返回 greet → 返回意图（greet 不需在列表里）', async () => {
    mockPorygonRun.mockResolvedValueOnce(
      JSON.stringify({ capability: 'greet', summary: '打招呼' })
    )
    const result = await detectIntent('你好')
    expect(result).toMatchObject({ capability: 'greet' })
  })

  it('LLM 返回 unknown → 返回 null', async () => {
    mockPorygonRun.mockResolvedValueOnce(
      JSON.stringify({ capability: 'unknown', summary: '无法识别' })
    )
    const result = await detectIntent('balabala')
    expect(result).toBeNull()
  })

  it('LLM 返回 null 文本 → 返回 null（跟进回复场景）', async () => {
    mockPorygonRun.mockResolvedValueOnce('null')
    const result = await detectIntent('好的')
    expect(result).toBeNull()
  })

  it('disabled trigger 的 key 也视为列表外 → 返回 null', async () => {
    mockListIMTriggers.mockResolvedValueOnce([
      makeTrigger('deploy'),
      makeTrigger('hidden_cap', false), // disabled
    ])
    mockPorygonRun.mockResolvedValueOnce(
      JSON.stringify({ capability: 'hidden_cap', summary: '触发隐藏能力' })
    )
    const result = await detectIntent('触发隐藏能力')
    expect(result).toBeNull()
  })
})
