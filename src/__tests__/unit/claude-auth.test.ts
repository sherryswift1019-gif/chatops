import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { buildClaudeAuthEnv } from '../../agent/claude-auth.js'

describe('buildClaudeAuthEnv - 双模式兼容', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  describe('模式 1：有效 API Key', () => {
    it('传入有效 API Key 时直接使用，不走 OAuth', () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'gw-should-not-be-used'
      process.env.ANTHROPIC_BASE_URL = 'http://proxy.example.com'

      const env = buildClaudeAuthEnv('sk-ant-api03-validkeyhere12345678901234567890')

      expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-api03-validkeyhere12345678901234567890')
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    })

    it('API Key 模式也传递 ANTHROPIC_BASE_URL（如果有）', () => {
      process.env.ANTHROPIC_BASE_URL = 'http://custom-proxy.example.com'

      const env = buildClaudeAuthEnv('sk-ant-api03-validkeyhere12345678901234567890')

      expect(env.ANTHROPIC_API_KEY).toBeTruthy()
      expect(env.ANTHROPIC_BASE_URL).toBe('http://custom-proxy.example.com')
    })

    it('OAuth token 误放到 ANTHROPIC_API_KEY 时自动纠正', () => {
      const env = buildClaudeAuthEnv('sk-ant-oat01-validoauthtoken12345678901234567890')

      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-validoauthtoken12345678901234567890')
      expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    })
  })

  describe('模式 2：Fallback 到 OAuth / 网关', () => {
    it('.env 没有有效 API Key 时，使用 shell 的 CLAUDE_CODE_OAUTH_TOKEN', () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'gw-gateway-token-12345'
      process.env.ANTHROPIC_BASE_URL = 'http://192.168.51.10:8080'

      const env = buildClaudeAuthEnv('')  // .env 为空

      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('gw-gateway-token-12345')
      expect(env.ANTHROPIC_BASE_URL).toBe('http://192.168.51.10:8080')
      expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    })

    it('.env 是无效占位符（如 sk-ant-...）时，走 OAuth fallback', () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'gw-gateway-token-12345'

      const env = buildClaudeAuthEnv('sk-ant-...')  // 10 个字符，不够 20

      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('gw-gateway-token-12345')
      expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    })

    it('shell 也没有 OAuth token 时返回空对象', () => {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN
      delete process.env.ANTHROPIC_BASE_URL

      const env = buildClaudeAuthEnv('')

      expect(Object.keys(env)).toHaveLength(0)
    })
  })

  describe('优先级验证', () => {
    it('API Key 优先于 OAuth token', () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'gw-should-not-be-used'

      const env = buildClaudeAuthEnv('sk-ant-api03-real-key-with-enough-length-here')

      expect(env.ANTHROPIC_API_KEY).toContain('sk-ant-api03')
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    })
  })
})
