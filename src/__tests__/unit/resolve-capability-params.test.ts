import { describe, it, expect } from 'vitest'
import { resolveCapabilityParams } from '../../pipeline/executor-hooks.js'

describe('resolveCapabilityParams', () => {
  it('returns undefined when params is undefined', () => {
    expect(resolveCapabilityParams(undefined, undefined, undefined)).toBeUndefined()
  })

  it('leaves literal string values unchanged', () => {
    const out = resolveCapabilityParams({ ref: 'main' }, undefined, undefined)
    expect(out).toEqual({ ref: 'main' })
  })

  it('resolves {{triggerParams.x}} to trigger param value, preserving type', () => {
    const out = resolveCapabilityParams(
      { ref: '{{triggerParams.branch}}', num: '{{triggerParams.count}}' },
      { branch: 'main', count: 42 },
      undefined,
    )
    expect(out).toEqual({ ref: 'main', num: 42 })
  })

  it('resolves {{vars.x}} from runtimeVars, preserving non-string types', () => {
    const out = resolveCapabilityParams(
      { ref: '{{vars.branch}}', flag: '{{vars.enabled}}', obj: '{{vars.payload}}' },
      undefined,
      { branch: 'main', enabled: true, payload: { a: 1 } },
    )
    expect(out).toEqual({ ref: 'main', flag: true, obj: { a: 1 } })
  })

  it('triggerParams takes precedence over vars when both keys collide', () => {
    const out = resolveCapabilityParams(
      { a: '{{triggerParams.a}}', b: '{{vars.a}}' },
      { a: 'from-trigger' },
      { a: 'from-vars' },
    )
    expect(out).toEqual({ a: 'from-trigger', b: 'from-vars' })
  })

  it('unresolved {{vars.x}} keeps the literal template', () => {
    const out = resolveCapabilityParams({ ref: '{{vars.missing}}' }, undefined, {})
    expect(out).toEqual({ ref: '{{vars.missing}}' })
  })

  it('embedded templates (non-whole-string match) are left as literal for v1', () => {
    const out = resolveCapabilityParams(
      { url: 'https://host/{{vars.path}}' },
      undefined,
      { path: 'abc' },
    )
    expect(out).toEqual({ url: 'https://host/{{vars.path}}' })
  })

  it('non-string values pass through untouched', () => {
    const out = resolveCapabilityParams({ count: 1, arr: [1, 2], obj: { x: 1 } }, undefined, undefined)
    expect(out).toEqual({ count: 1, arr: [1, 2], obj: { x: 1 } })
  })
})
