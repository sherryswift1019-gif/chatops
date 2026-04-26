import { describe, it, expect } from 'vitest'
import { resolveVariables, type VariableContext } from '../../pipeline/variables.js'

describe('variables — phase 3 扩展', () => {
  const ctx: VariableContext = {
    triggerParams: { project: 'ssh-proxy', env: 'dev' },
    vars: { branch: 'main' },
    steps: {
      load_config: { status: 'success', output: { rows: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }] } },
      build: { status: 'failed', output: { error: 'timeout', statusCode: 504 } },
    },
    server: { host: '10.0.0.1', port: 22 },
    run: { id: 42, startedAt: '2026-04-26T00:00:00Z' },
  } as any

  it('triggerParams.x', () => {
    expect(resolveVariables('{{triggerParams.project}}', ctx)).toBe('ssh-proxy')
  })

  it('vars.x', () => {
    expect(resolveVariables('{{vars.branch}}', ctx)).toBe('main')
  })

  it('steps.<id>.status', () => {
    expect(resolveVariables('{{steps.load_config.status}}', ctx)).toBe('success')
    expect(resolveVariables('{{steps.build.status}}', ctx)).toBe('failed')
  })

  it('steps.<id>.output.<field>', () => {
    expect(resolveVariables('{{steps.build.output.error}}', ctx)).toBe('timeout')
    expect(resolveVariables('{{steps.build.output.statusCode}}', ctx)).toBe('504')
  })

  it('JSONPath: array index', () => {
    expect(resolveVariables('{{steps.load_config.output.rows[0].id}}', ctx)).toBe('1')
    expect(resolveVariables('{{steps.load_config.output.rows[1].name}}', ctx)).toBe('b')
  })

  it('server.host / run.id', () => {
    expect(resolveVariables('{{server.host}}', ctx)).toBe('10.0.0.1')
    expect(resolveVariables('{{run.id}}', ctx)).toBe('42')
  })

  it('builtin filter: urlEncode', () => {
    expect(resolveVariables('{{triggerParams.project | urlEncode}}', { ...ctx, triggerParams: { project: 'a/b c' } } as any))
      .toBe('a%2Fb%20c')
  })

  it('builtin filter: lower / upper / jsonStringify', () => {
    expect(resolveVariables('{{triggerParams.project | upper}}', ctx)).toBe('SSH-PROXY')
    expect(resolveVariables('{{triggerParams.project | lower}}', { ...ctx, triggerParams: { project: 'SSH-PROXY' } } as any)).toBe('ssh-proxy')
    const out = resolveVariables('{{steps.load_config.output | jsonStringify}}', ctx)
    expect(JSON.parse(out)).toEqual({ rows: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }] })
  })

  it('unresolved variable returns literal placeholder', () => {
    expect(resolveVariables('{{vars.nonexistent}}', ctx)).toBe('{{vars.nonexistent}}')
  })

  it('scopes (fan_out 注入) 优先级最高', () => {
    const ctxWithScope = { ...ctx, scopes: { item: { project: 'overridden' } } } as any
    expect(resolveVariables('{{item.project}}', ctxWithScope)).toBe('overridden')
  })
})
