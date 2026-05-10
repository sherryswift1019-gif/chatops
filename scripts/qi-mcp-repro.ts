#!/usr/bin/env tsx
// 最小复现 Playwright MCP 偶发不可用：连续 6 次 fresh session 调 Claude，每次让它做一次 mcp__playwright__browser_navigate
process.env.DATABASE_URL ??= 'postgres://zhangshanshan@localhost:5432/chatops'
process.env.PLAYWRIGHT_CHROMIUM_BIN =
  '/Users/zhangshanshan/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'

const { ClaudeRunner, McpServerSpec } = await import('../src/agent/claude-runner.js')
const { PLAYWRIGHT_MCP } = await import('../src/agent/e2e-scenario/runner.js')

const runner = new ClaudeRunner()
const ITERATIONS = 6
let toolFoundCount = 0
let toolNotFoundCount = 0

for (let i = 0; i < ITERATIONS; i++) {
  const t0 = Date.now()
  const out = await runner.executeCapabilityDirect({
    prompt:
      '请用 mcp__playwright__browser_navigate 工具打开 http://example.com，' +
      '然后输出工具调用是否成功。如果调用失败请原文输出错误信息。',
    systemPrompt: '你是一个测试助手，专门用 Playwright MCP 工具验证网页。',
    context: {
      taskId: 'mcp-probe',
      groupId: 'probe',
      platform: 'internal',
      initiatorId: 'probe',
      initiatorRole: null,
    },
    tools: [],
    sessionKey: `mcp-probe-${i}-${Date.now()}`,
    freshSession: true,
    maxTurns: 5,
    timeoutMs: 60_000,
    disallowedTools: ['WebSearch', 'WebFetch', 'Agent'],
    extraMcpServers: PLAYWRIGHT_MCP,
  })
  const dt = Date.now() - t0
  const notFound = out.includes('No such tool available')
  if (notFound) toolNotFoundCount++
  else toolFoundCount++
  console.log(
    `\n[iter ${i + 1}/${ITERATIONS}] dt=${dt}ms ${notFound ? '✗ NOT_FOUND' : '✓ OK'}`,
  )
  console.log('  output (head 300):', out.slice(0, 300).replace(/\n/g, '⏎'))
}

console.log(`\n=== 总计 ${ITERATIONS}: ✓ ${toolFoundCount}  ✗ ${toolNotFoundCount} ===`)
process.exit(0)
