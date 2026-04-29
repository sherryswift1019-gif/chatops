/**
 * 单元测试：ClaudeRunner Step 6（通用 capability 对话路径）写 capability_invocations 审计日志
 *
 * 历史盲区：coordinator-invocation-log.test.ts 只覆盖 coordinator.triggerCapability()
 * 的 handler 路径，未覆盖 claude-runner.ts Step 6 直接调用 executeWithPorygon 的路径。
 * 该路径不经过 coordinator，先前完全没有审计记录写入。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── hoisted mock refs ────────────────────────────────────────────────────────
const mockPorygonRun = vi.hoisted(() => vi.fn<() => Promise<string>>())
const mockListIMTriggers = vi.hoisted(() => vi.fn())
const mockGetIMTrigger = vi.hoisted(() => vi.fn(async () => null))
const mockGetCapabilityByKey = vi.hoisted(() => vi.fn())
const mockCreateInvocation = vi.hoisted(() => vi.fn())
const mockFinishInvocation = vi.hoisted(() => vi.fn())
const mockCheckIMTriggerAccess = vi.hoisted(() => vi.fn())
const mockGetPermittedTools = vi.hoisted(() => vi.fn())
const mockGetTool = vi.hoisted(() => vi.fn())

// ─── mocks ────────────────────────────────────────────────────────────────────

vi.mock('@snack-kit/porygon', () => ({
  createPorygon: vi.fn(() => ({ run: mockPorygonRun, query: vi.fn() })),
}))

vi.mock('../../db/repositories/im-triggers.js', () => ({
  listIMTriggers: mockListIMTriggers,
  getIMTrigger: mockGetIMTrigger,
}))

vi.mock('../../db/repositories/system-config.js', () => ({
  getConfig: vi.fn(async () => null),
}))

vi.mock('../../agent/claude-config.js', () => ({
  buildClaudeEnv: vi.fn(async () => ({})),
}))

vi.mock('../../db/repositories/capabilities.js', () => ({
  getCapabilityByKey: mockGetCapabilityByKey,
  listCapabilities: vi.fn(),
}))

vi.mock('../../db/repositories/tasks.js', () => ({
  getRecentTasks: vi.fn(async () => []),
}))

vi.mock('../../db/repositories/product-line-im-triggers.js', () => ({
  checkIMTriggerAccess: mockCheckIMTriggerAccess,
  listProductLineIMTriggers: vi.fn(async () => []),
}))

vi.mock('../../db/repositories/product-lines.js', () => ({
  getProductLineById: vi.fn(async () => ({ id: 1, name: 'test-pl' })),
}))

vi.mock('../../db/repositories/projects-repo.js', () => ({
  listProjects: vi.fn(async () => []),
}))

vi.mock('../../db/repositories/test-servers.js', () => ({
  listTestServers: vi.fn(async () => []),
}))

vi.mock('../../db/repositories/product-line-envs.js', () => ({
  listProductLineEnvs: vi.fn(async () => []),
}))

vi.mock('../../db/repositories/environments-repo.js', () => ({
  listEnvironments: vi.fn(async () => []),
}))

vi.mock('../../db/repositories/approval-rules.js', () => ({
  getApprovalRules: vi.fn(async () => []),
}))

vi.mock('../../db/repositories/product-knowledge-repos.js', () => ({
  getByProductLineId: vi.fn(async () => []),
}))

vi.mock('../../db/repositories/prd-documents.js', () => ({
  getPrdDocumentById: vi.fn(),
}))

vi.mock('../../db/repositories/capability-invocations.js', () => ({
  createInvocation: mockCreateInvocation,
  finishInvocation: mockFinishInvocation,
}))

vi.mock('../../agent/coordinator.js', () => ({
  triggerCapability: vi.fn(),
  maybeCompleteAnalyze: vi.fn(),
  // 提供与 coordinator.ts 相同的实现，避免 mock 掉后变 undefined
  inferTriggerType: (platform: string) => {
    if (platform === 'dingtalk' || platform === 'feishu') return 'im'
    if (platform === 'test' || platform === 'e2e' || platform === 'api') return 'api'
    return 'manual'
  },
}))

vi.mock('../../approval/router.js', () => ({
  ApprovalRouter: class { route() { return null } },
}))

vi.mock('../../agent/deploy-lock.js', () => ({
  acquireLock: vi.fn(() => null),
  releaseLock: vi.fn(),
}))

vi.mock('../../agent/worktree/manager.js', () => ({
  acquire: vi.fn(),
  release: vi.fn(),
}))

vi.mock('../../agent/prd/reject-seed.js', () => ({
  buildRejectSystemPromptAppendix: vi.fn(async () => ''),
}))

vi.mock('../../agent/runner-greet-filter.js', () => ({
  filterImTriggerableTriggers: vi.fn(() => []),
}))

vi.mock('../../agent/tools/index.js', () => ({
  getTool: mockGetTool,
  getAllTools: vi.fn(() => []),
  getPermittedTools: mockGetPermittedTools,
}))

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeAdapter() {
  return {
    platform: 'dingtalk' as const,
    onMessage: vi.fn(),
    sendMessage: vi.fn(async () => {}),
    sendCard: vi.fn(async () => {}),
    sendDirectMessage: vi.fn(async () => {}),
    getUserInfo: vi.fn(async () => ({ userId: 'u1', name: 'Test User' })),
    onCardAction: vi.fn(),
    handleWebhook: vi.fn(async () => {}),
  }
}

const deployCapability = {
  id: 1, key: 'deploy', displayName: '部署',
  toolNames: ['deploy_tool'], requiresDeployLock: false, systemPrompt: '', description: '',
}

const mockDeployTool = {
  name: 'deploy_tool', description: 'deploy tool',
  riskLevel: 'medium' as const, schema: {}, execute: vi.fn(),
}

const baseRunOpts = (adapter: ReturnType<typeof makeAdapter>) => ({
  prompt: '部署服务',
  context: { taskId: 't1', groupId: 'g1', platform: 'dingtalk', initiatorId: 'u1', initiatorRole: 'developer' as const },
  groupId: 'g1',
  platform: 'dingtalk',
  adapter,
  productLineId: 1,
})

// ─── 测试 ─────────────────────────────────────────────────────────────────────

describe('ClaudeRunner Step 6 — capability_invocations 审计日志', () => {
  let runner: any

  beforeEach(async () => {
    vi.clearAllMocks()

    // 让 detectIntent 识别 'deploy' 为合法 key
    mockListIMTriggers.mockResolvedValue([{
      id: 1, key: 'deploy', displayName: '部署', description: '', pipelineId: null,
      capabilityKey: null, intentHints: '', examples: [], failureMessages: {},
      defaultApprovalRuleId: null, isSystem: false, enabled: true,
      createdAt: new Date(), updatedAt: new Date(),
    }])
    mockPorygonRun.mockResolvedValue(
      JSON.stringify({ capability: 'deploy', summary: '部署服务' })
    )

    mockGetIMTrigger.mockResolvedValue(null)
    mockGetCapabilityByKey.mockResolvedValue(deployCapability)
    mockCheckIMTriggerAccess.mockResolvedValue({ allowed: true })
    mockGetPermittedTools.mockResolvedValue([{ name: 'deploy_tool' }])
    mockGetTool.mockReturnValue(mockDeployTool)
    mockCreateInvocation.mockResolvedValue({ id: 888 })
    mockFinishInvocation.mockResolvedValue(undefined)

    const { ClaudeRunner } = await import('../../agent/claude-runner.js')
    runner = new ClaudeRunner()
  })

  it('通用 capability 成功执行 → createInvocation + finishInvocation(success)', async () => {
    vi.spyOn(runner as any, 'executeWithPorygon').mockResolvedValue(undefined)
    const adapter = makeAdapter()

    await runner.run(baseRunOpts(adapter))

    expect(mockCreateInvocation).toHaveBeenCalledOnce()
    expect(mockCreateInvocation).toHaveBeenCalledWith(expect.objectContaining({
      capabilityKey: 'deploy',
      triggerType: 'im',
      platform: 'dingtalk',
      groupId: 'g1',
      triggeredBy: 'u1',
      taskId: 't1',
    }))
    expect(mockFinishInvocation).toHaveBeenCalledWith(888, 'success', '', '')
  })

  it('executeWithPorygon 抛异常 → finishInvocation(failed, message)', async () => {
    vi.spyOn(runner as any, 'executeWithPorygon').mockRejectedValue(new Error('porygon timeout'))
    const adapter = makeAdapter()

    await runner.run(baseRunOpts(adapter))

    expect(mockCreateInvocation).toHaveBeenCalledOnce()
    expect(mockFinishInvocation).toHaveBeenCalledWith(888, 'failed', '', 'porygon timeout')
  })

  it('createInvocation DB 故障 → executeWithPorygon 仍执行，不调 finishInvocation', async () => {
    mockCreateInvocation.mockRejectedValueOnce(new Error('db down'))
    const execSpy = vi.spyOn(runner as any, 'executeWithPorygon').mockResolvedValue(undefined)
    const adapter = makeAdapter()

    await runner.run(baseRunOpts(adapter))

    expect(execSpy).toHaveBeenCalled()
    expect(mockFinishInvocation).not.toHaveBeenCalled()
  })
})
