import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../db/repositories/system-config.js', () => ({
  getConfig: vi.fn(),
}))

import { resolveGitlabConfig } from '../../config/gitlab.js'
import { getConfig } from '../../db/repositories/system-config.js'

describe('resolveGitlabConfig - DB 优先 env fallback', () => {
  const origEnv = { ...process.env }
  beforeEach(() => {
    vi.clearAllMocks()
    process.env = { ...origEnv }
    delete process.env.GITLAB_URL
    delete process.env.GITLAB_TOKEN
    delete process.env.GITLAB_SKIP_TLS_VERIFY
  })

  it('DB 有完整配置 {url, token, skipTlsVerify:true} → 返回 DB 值', async () => {
    ;(getConfig as any).mockResolvedValue({
      key: 'gitlab',
      value: { url: 'https://db.example.com', token: 'dbtoken', skipTlsVerify: 'true' },
      updatedAt: new Date(),
    })
    const cfg = await resolveGitlabConfig()
    expect(cfg).toEqual({ url: 'https://db.example.com', token: 'dbtoken', skipTlsVerify: true })
  })

  it('DB 有 {url, token} 但无 skipTlsVerify → skipTlsVerify=false', async () => {
    ;(getConfig as any).mockResolvedValue({
      key: 'gitlab',
      value: { url: 'https://db.example.com', token: 'dbtoken' },
      updatedAt: new Date(),
    })
    const cfg = await resolveGitlabConfig()
    expect(cfg.skipTlsVerify).toBe(false)
  })

  it('DB 为空 + env 有 GITLAB_URL/TOKEN → 返回 env 值', async () => {
    ;(getConfig as any).mockResolvedValue(null)
    process.env.GITLAB_URL = 'https://env.example.com'
    process.env.GITLAB_TOKEN = 'envtoken'
    const cfg = await resolveGitlabConfig()
    expect(cfg.url).toBe('https://env.example.com')
    expect(cfg.token).toBe('envtoken')
    expect(cfg.skipTlsVerify).toBe(false)
  })

  it('DB 为空 + env 有 GITLAB_SKIP_TLS_VERIFY=true → skipTlsVerify=true', async () => {
    ;(getConfig as any).mockResolvedValue(null)
    process.env.GITLAB_URL = 'https://env.example.com'
    process.env.GITLAB_TOKEN = 'envtoken'
    process.env.GITLAB_SKIP_TLS_VERIFY = 'true'
    const cfg = await resolveGitlabConfig()
    expect(cfg.skipTlsVerify).toBe(true)
  })

  it('DB 和 env 都空 → 返回全空（不抛异常）', async () => {
    ;(getConfig as any).mockResolvedValue(null)
    const cfg = await resolveGitlabConfig()
    expect(cfg).toEqual({ url: '', token: '', skipTlsVerify: false })
  })
})
