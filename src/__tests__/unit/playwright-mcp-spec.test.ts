import { describe, it, expect } from 'vitest'
import { existsSync } from 'fs'
import { PLAYWRIGHT_MCP } from '../../agent/e2e-scenario/runner.js'

// 这个 spec 锁定不变量：Playwright MCP 必须用本地 node_modules 里装好的 cli.js 启动，
// 不再用 `npx -y @playwright/mcp@latest` 现场下载。
// 修因：npx 冷启动需 50s+ 拉 17MB，与 Claude CLI MCP init 形成 race condition，
// host Claude 看到的 tools/list 不含 mcp__playwright__*，调用时报"No such tool available"。
// （详见 src/agent/e2e-scenario/runner.ts 的相关注释）
describe('PLAYWRIGHT_MCP spec', () => {
  it('用 node 启动本地 cli.js（不允许 revert 回 npx）', () => {
    expect(PLAYWRIGHT_MCP.playwright.command).toBe('node')
  })

  it('args[0] 指向 node_modules/@playwright/mcp/cli.js 且文件实际存在', () => {
    const cli = PLAYWRIGHT_MCP.playwright.args?.[0]
    expect(cli).toBeTruthy()
    expect(cli).toMatch(/node_modules\/@playwright\/mcp\/cli\.js$/)
    // 路径必须是文件系统真实存在 — 防止 dependency 漏装让运行时再爆"No such tool"
    expect(existsSync(cli!)).toBe(true)
  })

  it('保留 chromium 路径 / no-sandbox / headless 旧标志', () => {
    const args = PLAYWRIGHT_MCP.playwright.args ?? []
    expect(args.some((a) => a.includes('--executable-path=/ms-playwright/'))).toBe(true)
    expect(args).toContain('--no-sandbox')
    expect(args).toContain('--headless')
  })
})
