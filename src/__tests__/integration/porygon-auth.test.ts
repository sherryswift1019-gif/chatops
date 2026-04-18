/**
 * 集成测试：验证 Porygon / Claude CLI 通过内网代理正常调用
 * 测试 buildClaudeAuthEnv 构建的凭证能让 Claude CLI 成功响应
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { createPorygon, type Porygon } from '@snack-kit/porygon'
import { buildClaudeAuthEnv } from '../../agent/claude-auth.js'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

describe('Integration: Porygon + Claude CLI 调用', () => {
  let porygon: Porygon
  let authEnv: Record<string, string>

  beforeAll(() => {
    authEnv = buildClaudeAuthEnv(process.env.ANTHROPIC_API_KEY)
    console.log('[Test] Auth env keys:', Object.keys(authEnv))
    for (const [k, v] of Object.entries(authEnv)) {
      console.log(`[Test]   ${k} = ${v?.substring(0, 20)}...`)
    }

    porygon = createPorygon({
      defaultBackend: 'claude',
      backends: {
        claude: {
          model: 'sonnet',
          interactive: false,
          cliPath: join(__dirname, '..', '..', '..', 'node_modules', '.bin', 'claude'),
        },
      },
      defaults: { timeoutMs: 30_000, maxTurns: 1 },
    })
  })

  it('buildClaudeAuthEnv 包含 CLAUDE_CODE_OAUTH_TOKEN', () => {
    expect(authEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeTruthy()
    expect(authEnv.CLAUDE_CODE_OAUTH_TOKEN.startsWith('gw-')).toBe(true)
  })

  it('buildClaudeAuthEnv 包含 ANTHROPIC_BASE_URL', () => {
    expect(authEnv.ANTHROPIC_BASE_URL).toBeTruthy()
    expect(authEnv.ANTHROPIC_BASE_URL).toContain('192.168')
  })

  it('Porygon 能成功调用 Claude（走内网代理）', async () => {
    const result = await porygon.run({
      prompt: '只回复两个字：成功',
      appendSystemPrompt: '你是测试机器人。只回复"成功"两个字，不要说其他任何内容。',
      envVars: authEnv,
    })

    console.log('[Test] Porygon result:', result)
    const text = typeof result === 'string' ? result : JSON.stringify(result)

    // 不应该是限额错误
    expect(text).not.toContain('hit your limit')
    expect(text).not.toContain('resets')
    // 应该有实际回复
    expect(text.length).toBeGreaterThan(0)
  }, 30_000)
})
