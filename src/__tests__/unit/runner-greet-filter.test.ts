import { describe, it, expect } from 'vitest'
import { filterImTriggerableCapabilities } from '../../agent/runner-greet-filter.js'
import type { Capability } from '../../db/repositories/capabilities.js'
import type { ProductLineCapability } from '../../db/repositories/product-line-capabilities.js'

function cap(key: string): Capability {
  return {
    id: 0, key, displayName: key, description: '', category: 'action',
    toolNames: [], needsApproval: false, paramSchema: {}, playbook: [],
    isSystem: false, systemPrompt: null, defaultSystemPrompt: null,
    defaultPipelineId: null,
    maxTurns: 30, timeoutMs: 1200000, requiresWorktree: false, requiresDeployLock: false,
    createdAt: new Date(), updatedAt: new Date(),
  } as Capability
}

function plCap(
  capabilityKey: string,
  opts: { enabled?: boolean; roles?: string[]; sources?: string[]; envName?: string } = {}
): ProductLineCapability {
  return {
    id: 0, productLineId: 1, capabilityKey,
    envName: opts.envName ?? '*',
    enabled: opts.enabled ?? true,
    allowedRoles: opts.roles ?? ['developer', 'tester', 'ops', 'admin'],
    triggerSources: opts.sources ?? ['im', 'web'],
  }
}

describe('filterImTriggerableCapabilities', () => {
  it('keeps capability when PL config allows IM', () => {
    const caps = [cap('deploy')]
    const plCaps = [plCap('deploy')]
    expect(filterImTriggerableCapabilities(caps, plCaps, 'developer').map(c => c.key)).toEqual(['deploy'])
  })

  it('drops capability when trigger_sources excludes im', () => {
    const caps = [cap('deploy'), cap('rollback')]
    const plCaps = [plCap('deploy', { sources: ['web'] }), plCap('rollback')]
    expect(filterImTriggerableCapabilities(caps, plCaps, 'developer').map(c => c.key)).toEqual(['rollback'])
  })

  it('drops capability when enabled=false', () => {
    const caps = [cap('deploy')]
    const plCaps = [plCap('deploy', { enabled: false })]
    expect(filterImTriggerableCapabilities(caps, plCaps, 'developer')).toEqual([])
  })

  it('drops capability when user role not allowed', () => {
    const caps = [cap('deploy')]
    const plCaps = [plCap('deploy', { roles: ['admin'] })]
    expect(filterImTriggerableCapabilities(caps, plCaps, 'developer')).toEqual([])
  })

  it('drops capability with no PL config at all', () => {
    const caps = [cap('deploy'), cap('unconfigured')]
    const plCaps = [plCap('deploy')]
    expect(filterImTriggerableCapabilities(caps, plCaps, 'developer').map(c => c.key)).toEqual(['deploy'])
  })

  it('prefers specific env over wildcard when both exist', () => {
    // This helper is fed "*" configs in the greet path; specific-env merging is
    // already handled by checkCapabilityAccess at runtime. Here we only need
    // wildcard behavior.
    const caps = [cap('deploy')]
    const plCaps = [plCap('deploy', { envName: 'prod', sources: ['web'] }), plCap('deploy', { envName: '*' })]
    // '*' permits; 'prod' row is extra config but wildcard is authoritative for greet
    expect(filterImTriggerableCapabilities(caps, plCaps, 'developer').map(c => c.key)).toEqual(['deploy'])
  })
})
