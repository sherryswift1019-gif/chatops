import { describe, it, expect, beforeEach } from 'vitest'
import {
  registerNodeType,
  getRegisteredNodeTypeKeys,
  getExecutor,
  __resetRegistryForTesting,
  assertRegistryConsistent,
} from '../../pipeline/node-types/registry.js'
import type { NodeExecutor, ExecutionContext } from '../../pipeline/node-types/types.js'

describe('node-type registry', () => {
  beforeEach(() => { __resetRegistryForTesting() })

  it('registers and looks up executor by key', () => {
    const dummy: NodeExecutor = {
      key: 'dummy',
      async execute(_params, _ctx) { return { status: 'success', output: { ok: true } } },
    }
    registerNodeType(dummy)
    expect(getRegisteredNodeTypeKeys()).toEqual(new Set(['dummy']))
    expect(getExecutor('dummy')).toBe(dummy)
  })

  it('throws on duplicate registration', () => {
    const a: NodeExecutor = { key: 'x', async execute() { return { status: 'success', output: {} } } }
    registerNodeType(a)
    expect(() => registerNodeType(a)).toThrow(/already registered/)
  })

  it('assertRegistryConsistent reports DB-only and code-only diffs', () => {
    registerNodeType({ key: 'a', async execute() { return { status: 'success', output: {} } } })
    expect(() => assertRegistryConsistent(new Set(['a','b']))).toThrow(/DB only.*b/)
    expect(() => assertRegistryConsistent(new Set([]))).toThrow(/Code only.*a/)
    expect(() => assertRegistryConsistent(new Set(['a']))).not.toThrow()
  })
})
