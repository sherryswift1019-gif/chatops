import { describe, it, expect } from 'vitest'
import { filterImTriggerableTriggers } from '../../agent/runner-greet-filter.js'
import type { IMTrigger } from '../../db/repositories/im-triggers.js'
import type { ProductLineIMTrigger } from '../../db/repositories/product-line-im-triggers.js'

function trig(key: string, opts: { enabled?: boolean } = {}): IMTrigger {
  return {
    id: 0, key, displayName: key, description: '',
    category: 'ops',
    pipelineId: null, capabilityKey: null, intentHints: '', examples: [], failureMessages: {},
    defaultApprovalRuleId: null, isSystem: false,
    enabled: opts.enabled ?? true,
    createdAt: new Date(), updatedAt: new Date(),
  }
}

function plTrig(
  imTriggerKey: string,
  opts: { enabled?: boolean; roles?: string[]; sources?: string[]; envName?: string } = {}
): ProductLineIMTrigger {
  return {
    id: 0, productLineId: 1, imTriggerKey,
    envName: opts.envName ?? '*',
    enabled: opts.enabled ?? true,
    allowedRoles: opts.roles ?? ['developer', 'tester', 'ops', 'admin'],
    triggerSources: opts.sources ?? ['im', 'web'],
    approvalRuleId: null,
  }
}

describe('filterImTriggerableTriggers', () => {
  it('keeps trigger when PL config allows IM', () => {
    const triggers = [trig('deploy')]
    const plTriggers = [plTrig('deploy')]
    expect(filterImTriggerableTriggers(triggers, plTriggers, 'developer').map(t => t.key)).toEqual(['deploy'])
  })

  it('drops trigger when trigger_sources excludes im', () => {
    const triggers = [trig('deploy'), trig('rollback')]
    const plTriggers = [plTrig('deploy', { sources: ['web'] }), plTrig('rollback')]
    expect(filterImTriggerableTriggers(triggers, plTriggers, 'developer').map(t => t.key)).toEqual(['rollback'])
  })

  it('drops trigger when PL config enabled=false', () => {
    const triggers = [trig('deploy')]
    const plTriggers = [plTrig('deploy', { enabled: false })]
    expect(filterImTriggerableTriggers(triggers, plTriggers, 'developer')).toEqual([])
  })

  it('drops trigger when im_trigger itself is disabled', () => {
    const triggers = [trig('deploy', { enabled: false })]
    const plTriggers = [plTrig('deploy')]
    expect(filterImTriggerableTriggers(triggers, plTriggers, 'developer')).toEqual([])
  })

  it('drops trigger when user role not allowed', () => {
    const triggers = [trig('deploy')]
    const plTriggers = [plTrig('deploy', { roles: ['admin'] })]
    expect(filterImTriggerableTriggers(triggers, plTriggers, 'developer')).toEqual([])
  })

  it('drops trigger with no PL config at all', () => {
    const triggers = [trig('deploy'), trig('unconfigured')]
    const plTriggers = [plTrig('deploy')]
    expect(filterImTriggerableTriggers(triggers, plTriggers, 'developer').map(t => t.key)).toEqual(['deploy'])
  })

  it('uses wildcard env config and ignores env-specific rows', () => {
    // greet 场景只看 env='*' 的配置;env 特定配置不参与决策(运行时由 checkIMTriggerAccess 处理)。
    const triggers = [trig('deploy')]
    const plTriggers = [plTrig('deploy', { envName: 'prod', sources: ['web'] }), plTrig('deploy', { envName: '*' })]
    expect(filterImTriggerableTriggers(triggers, plTriggers, 'developer').map(t => t.key)).toEqual(['deploy'])
  })
})
