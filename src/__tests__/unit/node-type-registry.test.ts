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

describe('node-type barrel', () => {
  it('registers all 13 stage types when index is imported (T17 capability → llm_agent + switch + invoke_target_script)', async () => {
    __resetRegistryForTesting()
    // 动态 import barrel 触发自注册
    await import('../../pipeline/node-types/index.js')
    const keys = getRegisteredNodeTypeKeys()
    expect(keys).toEqual(new Set([
      'script','approval','llm_agent','wait_webhook',
      'http','dm','db_update','sql_query','file_read','template_render','fan_out','switch',
      'invoke_target_script',
    ]))
  })
})
