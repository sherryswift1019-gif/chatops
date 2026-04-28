import { describe, it, expect } from 'vitest'
import { resolveVariables, type VariableContext } from '../../pipeline/variables.js'

const baseCtx: VariableContext = {
  productLine: { name: 'pl', displayName: 'PL' },
  pipeline: { id: 1, name: 'p' },
  run: { id: 1, triggeredBy: 'user', triggerType: 'api' },
  stage: { name: 's', index: 0 },
  server: { host: 'h', port: 22, username: 'u', name: 'n', role: 'r' },
  vars: {},
}

describe('triggerParams 模板解析', () => {
  it('{{triggerParams.foo}} 取顶层字段', () => {
    const ctx = { ...baseCtx, triggerParams: { foo: 'bar' } }
    expect(resolveVariables('{{triggerParams.foo}}', ctx)).toBe('bar')
  })

  it('{{triggerParams.a.b}} 嵌套字段', () => {
    const ctx = { ...baseCtx, triggerParams: { a: { b: 'nested' } } }
    expect(resolveVariables('{{triggerParams.a.b}}', ctx)).toBe('nested')
  })

  it('{{triggerParams.commits[0].id}} 数组索引', () => {
    const ctx = { ...baseCtx, triggerParams: { commits: [{ id: 'abc123' }] } }
    expect(resolveVariables('{{triggerParams.commits[0].id}}', ctx)).toBe('abc123')
  })

  it('不存在的字段保留 {{...}} 字面量', () => {
    const ctx = { ...baseCtx, triggerParams: {} }
    expect(resolveVariables('{{triggerParams.missing}}', ctx)).toBe('{{triggerParams.missing}}')
  })

  it('无 triggerParams 时保留字面量', () => {
    expect(resolveVariables('{{triggerParams.foo}}', baseCtx)).toBe('{{triggerParams.foo}}')
  })
})
