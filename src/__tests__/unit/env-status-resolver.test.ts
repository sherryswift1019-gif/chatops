import { describe, it, expect } from 'vitest'
import { resolveProjectStatus } from '../../agent/tools/env-status/resolver.js'

const baseDeployed = { branch: 'develop', shortId: 'a1b2c3d4', imageTag: 'develop_a1b2c3d4' }
const baseLatest = { commitId: 'full', shortId: 'a1b2c3d4', message: 'x' }

describe('resolveProjectStatus', () => {
  it('healthy when running + same commit', () => {
    const r = resolveProjectStatus({
      probe: { container: { exists: true, state: 'running', health: 'healthy' }, deployed: baseDeployed },
      latest: baseLatest,
      compare: null,
      hasHistory: true,
    })
    expect(r.status).toBe('healthy')
    expect(r.commitsBehind).toBe(0)
  })

  it('healthy when running + no healthcheck + same commit', () => {
    const r = resolveProjectStatus({
      probe: { container: { exists: true, state: 'running', health: 'none' }, deployed: baseDeployed },
      latest: baseLatest,
      compare: null,
      hasHistory: true,
    })
    expect(r.status).toBe('healthy')
  })

  it('stale when commits differ', () => {
    const r = resolveProjectStatus({
      probe: { container: { exists: true, state: 'running', health: 'healthy' }, deployed: baseDeployed },
      latest: { ...baseLatest, shortId: '99887766' },
      compare: { commitsBehind: 7, tooLarge: false, latestSummaries: [] },
      hasHistory: true,
    })
    expect(r.status).toBe('stale')
    expect(r.commitsBehind).toBe(7)
  })

  it('degraded when running but unhealthy', () => {
    const r = resolveProjectStatus({
      probe: { container: { exists: true, state: 'running', health: 'unhealthy' }, deployed: baseDeployed },
      latest: baseLatest,
      compare: null,
      hasHistory: true,
    })
    expect(r.status).toBe('degraded')
  })

  it('down when exited', () => {
    const r = resolveProjectStatus({
      probe: { container: { exists: true, state: 'exited', exitCode: 137 }, deployed: baseDeployed },
      latest: baseLatest,
      compare: null,
      hasHistory: true,
    })
    expect(r.status).toBe('down')
  })

  it('not_deployed when no container and no history', () => {
    const r = resolveProjectStatus({
      probe: { container: { exists: false }, deployed: null },
      latest: baseLatest,
      compare: null,
      hasHistory: false,
    })
    expect(r.status).toBe('not_deployed')
  })

  it('unknown when probe returns explicit error', () => {
    const r = resolveProjectStatus({
      probe: { container: { exists: false }, deployed: null, error: 'compose file not found' },
      latest: baseLatest,
      compare: null,
      hasHistory: true,
    })
    expect(r.status).toBe('unknown')
  })

  it('down when no container but history exists', () => {
    const r = resolveProjectStatus({
      probe: { container: { exists: false }, deployed: null },
      latest: baseLatest,
      compare: null,
      hasHistory: true,
    })
    expect(r.status).toBe('down')
  })

  it('unknown when running but tag cannot be parsed', () => {
    const r = resolveProjectStatus({
      probe: { container: { exists: true, state: 'running', health: 'none' }, deployed: null },
      latest: baseLatest,
      compare: null,
      hasHistory: true,
    })
    expect(r.status).toBe('unknown')
  })

  it('commitsBehindNote too_large when compare timed out', () => {
    const r = resolveProjectStatus({
      probe: { container: { exists: true, state: 'running', health: 'healthy' }, deployed: baseDeployed },
      latest: { ...baseLatest, shortId: '99887766' },
      compare: { commitsBehind: null, tooLarge: true, latestSummaries: [] },
      hasHistory: true,
    })
    expect(r.status).toBe('stale')
    expect(r.commitsBehind).toBeNull()
    expect(r.commitsBehindNote).toBe('too_large')
  })
})
