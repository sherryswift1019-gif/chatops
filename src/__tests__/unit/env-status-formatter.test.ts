import { describe, it, expect } from 'vitest'
import { formatEnvStatusOutput } from '../../agent/tools/env-status/formatter.js'
import type { ResolvedProject } from '../../agent/tools/env-status/resolver.js'

function proj(name: string, over: Partial<ResolvedProject> & { status: ResolvedProject['status'] }): {
  name: string
  displayName: string
  resolved: ResolvedProject
  container: { state?: string; startedAt?: string; serviceName?: string; actualName?: string }
  servers: string[]
} {
  return {
    name,
    displayName: name,
    resolved: {
      deployed: null, latest: null, commitsBehind: null,
      ...over,
    } as ResolvedProject,
    container: {
      state: 'running',
      startedAt: new Date(Date.now() - 3600_000).toISOString(),
      serviceName: name,
      actualName: `pam-${name}`,
    },
    servers: ['10.0.0.5'],
  }
}

describe('formatEnvStatusOutput', () => {
  it('renders headline with product line and branch', () => {
    const out = formatEnvStatusOutput({
      env: 'dev',
      productLine: 'paraview',
      defaultBranch: 'develop',
      projects: [],
    })
    expect(out).toContain('环境: dev')
    expect(out).toContain('产线: paraview')
    expect(out).toContain('默认分支: develop')
  })

  it('shows healthy with ✅', () => {
    const out = formatEnvStatusOutput({
      env: 'dev', productLine: 'pl', defaultBranch: 'develop',
      projects: [proj('ssh-proxy', {
        status: 'healthy',
        deployed: { branch: 'develop', shortId: 'a1b2c3d4', imageTag: 'develop_a1b2c3d4' },
        latest: { commitId: '...', shortId: 'a1b2c3d4', message: 'fix' },
        commitsBehind: 0,
      })],
    })
    expect(out).toContain('ssh-proxy')
    expect(out).toContain('ssh-proxy -> pam-ssh-proxy')
    expect(out).toContain('✅')
    expect(out).toContain('develop_a1b2c3d4')
  })

  it('shows stale with 🟡 and commits behind count', () => {
    const out = formatEnvStatusOutput({
      env: 'dev', productLine: 'pl', defaultBranch: 'develop',
      projects: [proj('rdp-proxy', {
        status: 'stale',
        deployed: { branch: 'develop', shortId: '11223344', imageTag: 'develop_11223344' },
        latest: { commitId: '...', shortId: '99887766', message: 'feat' },
        commitsBehind: 7,
      })],
    })
    expect(out).toContain('🟡')
    expect(out).toContain('落后 7 个 commit')
  })

  it('appends "跨度较大" when commitsBehind >= 30', () => {
    const out = formatEnvStatusOutput({
      env: 'dev', productLine: 'pl', defaultBranch: 'develop',
      projects: [proj('billing', {
        status: 'stale',
        deployed: { branch: 'develop', shortId: 'deadbeef', imageTag: 'develop_deadbeef' },
        latest: { commitId: '...', shortId: 'cafebabe', message: 'x' },
        commitsBehind: 42,
      })],
    })
    expect(out).toContain('跨度较大')
  })

  it('marks too_large compare with ⚠️ 跨度过大', () => {
    const out = formatEnvStatusOutput({
      env: 'dev', productLine: 'pl', defaultBranch: 'develop',
      projects: [proj('svc', {
        status: 'stale',
        deployed: { branch: 'develop', shortId: 'aaaaaaaa', imageTag: 'develop_aaaaaaaa' },
        latest: { commitId: '...', shortId: 'bbbbbbbb', message: 'x' },
        commitsBehind: null,
        commitsBehindNote: 'too_large',
      })],
    })
    expect(out).toContain('跨度过大')
  })

  it('shows not_deployed with ⚪', () => {
    const out = formatEnvStatusOutput({
      env: 'dev', productLine: 'pl', defaultBranch: 'develop',
      projects: [proj('newsvc', { status: 'not_deployed' })],
    })
    expect(out).toContain('⚪')
    expect(out).toContain('未部署')
  })
})
