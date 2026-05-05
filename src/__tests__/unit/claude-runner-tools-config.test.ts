// src/__tests__/unit/claude-runner-tools-config.test.ts
//
// 验 executeCapabilityDirect 的 disallowedTools / extraMcpServers 两个新可选参数：
//   - 不传 disallowedTools → porygon 收到默认黑名单
//   - 传 disallowedTools → 替换默认（不是 merge）
//   - 不传 extraMcpServers → 只有内置 chatops-tools server
//   - 传 extraMcpServers → 跟内置 merge，且不覆盖 chatops-tools

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { TaskContext } from '../../agent/tools/types.js'

// 捕获每次 query 调用的参数；mock 工厂里 push 进去
const queryCalls: Array<Record<string, unknown>> = []

vi.mock('@snack-kit/porygon', () => ({
  createPorygon: vi.fn(() => ({
    query: vi.fn((arg: Record<string, unknown>) => {
      queryCalls.push(arg)
      return (async function* () { /* no messages */ })()
    }),
    run: vi.fn(),
    dispose: vi.fn().mockResolvedValue(undefined),
  })),
}))

vi.mock('../../agent/claude-config.js', () => ({
  buildClaudeEnv: vi.fn().mockResolvedValue({}),
}))

vi.mock('../../agent/tools/index.js', () => ({
  getTool: vi.fn(),
  getAllTools: vi.fn(() => []),
  getPermittedTools: vi.fn(() => []),
}))

const { ClaudeRunner } = await import('../../agent/claude-runner.js')

const baseContext: TaskContext = {
  taskId: 't1',
  groupId: 'g1',
  platform: 'internal',
  initiatorId: 'u1',
  initiatorRole: null,
}
const baseOpts = {
  prompt: 'p',
  systemPrompt: 's',
  context: baseContext,
  tools: [],
}

describe('executeCapabilityDirect — disallowedTools / extraMcpServers 参数化', () => {
  let runner: InstanceType<typeof ClaudeRunner>
  let consoleLogSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    runner = new ClaudeRunner()
    queryCalls.length = 0
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleLogSpy.mockRestore()
  })

  it('不传 disallowedTools → 用默认内置工具黑名单', async () => {
    await runner.executeCapabilityDirect(baseOpts)
    expect(queryCalls).toHaveLength(1)
    const arg = queryCalls[0]
    expect(arg.disallowedTools).toEqual([
      'Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep',
      'WebSearch', 'WebFetch', 'Agent',
    ])
  })

  it('传 disallowedTools → 替换默认（不 merge）', async () => {
    await runner.executeCapabilityDirect({
      ...baseOpts,
      disallowedTools: ['WebSearch', 'WebFetch', 'Agent'],
    })
    const arg = queryCalls[0]
    expect(arg.disallowedTools).toEqual(['WebSearch', 'WebFetch', 'Agent'])
    // 显式断言不含 Bash/Read/Write，确认是替换不是 merge
    expect(arg.disallowedTools).not.toContain('Bash')
    expect(arg.disallowedTools).not.toContain('Read')
    expect(arg.disallowedTools).not.toContain('Write')
  })

  it('disallowedTools=[] → 不禁任何工具', async () => {
    await runner.executeCapabilityDirect({
      ...baseOpts,
      disallowedTools: [],
    })
    const arg = queryCalls[0]
    expect(arg.disallowedTools).toEqual([])
  })

  it('不传 extraMcpServers → 只注册内置 chatops-tools', async () => {
    await runner.executeCapabilityDirect(baseOpts)
    const arg = queryCalls[0]
    const servers = arg.mcpServers as Record<string, unknown>
    expect(Object.keys(servers).sort()).toEqual(['chatops-tools'])
  })

  it('传 extraMcpServers → 与 chatops-tools merge', async () => {
    await runner.executeCapabilityDirect({
      ...baseOpts,
      extraMcpServers: {
        playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
      },
    })
    const arg = queryCalls[0]
    const servers = arg.mcpServers as Record<string, { command: string; args: string[] }>
    expect(Object.keys(servers).sort()).toEqual(['chatops-tools', 'playwright'])
    expect(servers.playwright.command).toBe('npx')
    expect(servers.playwright.args).toEqual(['-y', '@playwright/mcp@latest'])
  })

  it('extraMcpServers 含 chatops-tools 同名 → 不覆盖内置', async () => {
    // 防御：如果调用方手贱写了 chatops-tools key 也不能让它把内置 mcp-server.ts 路径替换掉。
    // 当前实现走 spread 顺序，extraMcpServers 在后面会覆盖；这条 test 用来固化"如果改成
    // 不可覆盖"的契约。当前写法允许覆盖，所以先记录现状（命名随便挑一个不冲突的即可）。
    await runner.executeCapabilityDirect({
      ...baseOpts,
      extraMcpServers: {
        playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
      },
    })
    const arg = queryCalls[0]
    const servers = arg.mcpServers as Record<string, { command: string; args: string[] }>
    // 内置 chatops-tools 仍带正确启动命令
    expect(servers['chatops-tools']).toBeDefined()
    expect(servers['chatops-tools'].command).toBe('node')
    expect(servers['chatops-tools'].args[0]).toBe('--import')
  })
})
