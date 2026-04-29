import { describe, it, expect } from 'vitest'
import { resolveCapabilityParams } from '../../pipeline/executor-hooks.js'
import type { VariableContext } from '../../pipeline/variables.js'

function makeCtx(over: Partial<VariableContext> = {}): VariableContext {
  return {
    productLine: { name: '', displayName: '' },
    pipeline: { id: 0, name: '' },
    run: { id: 0, triggeredBy: '', triggerType: '' },
    stage: { name: '', index: 0 },
    server: { host: '', port: 0, username: '', name: '', role: '' },
    vars: {},
    triggerParams: {},
    steps: {},
    scopes: {},
    ...over,
  }
}

describe('resolveCapabilityParams (legacy 3-arg signature)', () => {
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

// ---- 新 2-arg overload (params, varCtx) — 支持 nested path 与 steps/scopes ----
//
// 三段式解析：triggerParams 旧路径 → vars 旧路径 → resolvePath fallback。
// 整值匹配（^{{...}}$）保留类型；嵌入式模板与非字符串保持现状。
describe('resolveCapabilityParams (2-arg overload with VariableContext)', () => {
  it('resolves {{steps.<id>.output.<key>}} from ctx.steps, preserving type', () => {
    const ctx = makeCtx({
      steps: {
        load: { status: 'success', output: { id: 7, name: 'alice' } },
      },
    })
    const out = resolveCapabilityParams(
      { uid: '{{steps.load.output.id}}', uname: '{{steps.load.output.name}}' },
      ctx,
    )
    expect(out).toEqual({ uid: 7, uname: 'alice' })
  })

  it('resolves nested {{vars.obj.field}} from ctx.vars (non-string values preserved)', () => {
    const ctx = makeCtx({
      // 注意 VariableContext.vars 类型是 Record<string,string>，但 resolvePath
      // 走通用对象访问，所以 nested 对象在运行时也能被解析（caller 传入更宽松的
      // 形状是常态）。
      vars: { config: { region: 'us-east-1', replicas: 3 } } as unknown as Record<string, string>,
    })
    const out = resolveCapabilityParams(
      { region: '{{vars.config.region}}', n: '{{vars.config.replicas}}' },
      ctx,
    )
    expect(out).toEqual({ region: 'us-east-1', n: 3 })
  })

  it('resolves nested {{triggerParams.x.y}} from ctx.triggerParams', () => {
    const ctx = makeCtx({
      triggerParams: { user: { id: 42, name: 'bob' } },
    })
    const out = resolveCapabilityParams(
      { uid: '{{triggerParams.user.id}}', uname: '{{triggerParams.user.name}}' },
      ctx,
    )
    expect(out).toEqual({ uid: 42, uname: 'bob' })
  })

  it('resolves array index {{steps.x.output.rows[0].id}}', () => {
    const ctx = makeCtx({
      steps: {
        q: { status: 'success', output: { rows: [{ id: 1 }, { id: 2 }] } },
      },
    })
    const out = resolveCapabilityParams(
      { first: '{{steps.q.output.rows[0].id}}' },
      ctx,
    )
    expect(out).toEqual({ first: 1 })
  })

  it('unresolved nested path keeps literal template (符合 resolveVariables 语义)', () => {
    const ctx = makeCtx({ steps: {} })
    const out = resolveCapabilityParams(
      { v: '{{steps.missing.output.x}}' },
      ctx,
    )
    expect(out).toEqual({ v: '{{steps.missing.output.x}}' })
  })

  it('legacy single-segment {{triggerParams.x}} still works through new overload', () => {
    const ctx = makeCtx({ triggerParams: { branch: 'main', count: 42 } })
    const out = resolveCapabilityParams(
      { ref: '{{triggerParams.branch}}', num: '{{triggerParams.count}}' },
      ctx,
    )
    expect(out).toEqual({ ref: 'main', num: 42 })
  })

  it('legacy single-segment {{vars.x}} still works through new overload', () => {
    const ctx = makeCtx({
      vars: { enabled: true, payload: { a: 1 } } as unknown as Record<string, string>,
    })
    const out = resolveCapabilityParams(
      { flag: '{{vars.enabled}}', obj: '{{vars.payload}}' },
      ctx,
    )
    expect(out).toEqual({ flag: true, obj: { a: 1 } })
  })

  it('embedded templates remain literal in 2-arg overload too', () => {
    const ctx = makeCtx({
      steps: { x: { status: 'success', output: { name: 'alice' } } },
    })
    const out = resolveCapabilityParams(
      { msg: 'hello {{steps.x.output.name}}' },
      ctx,
    )
    expect(out).toEqual({ msg: 'hello {{steps.x.output.name}}' })
  })

  it('priority: scopes > steps > vars > triggerParams (single-segment ambiguity)', () => {
    // 注意：legacy 优先级在 3-arg 形态固定 triggerParams > vars。新 overload
    // 走 resolvePath，遵循 spec §4.5 priority（scopes > steps > vars > triggerParams）。
    const ctx = makeCtx({
      scopes: { token: 'from-scope' },
      steps: { token: 'from-steps' } as unknown as Record<string, unknown>,
      vars: { token: 'from-vars' } as unknown as Record<string, string>,
      triggerParams: { token: 'from-trigger' },
    })
    // 单段 `{{token}}` 触发 resolvePath 优先级链
    const out = resolveCapabilityParams({ x: '{{token}}' }, ctx)
    expect(out).toEqual({ x: 'from-scope' })
  })
})

// 关键幂等性：把 resolveCapabilityParams 输出再喂一遍，结果不变。
// 防止 buildCapabilityNode 先 resolve 一次，再走 hook 内部又 resolve 一次时
// 出现"二次解析炸"或类型畸变。
describe('resolveCapabilityParams idempotency (double-resolve no-op)', () => {
  it('legacy 3-arg form: re-resolving already-resolved params returns identical structure', () => {
    const once = resolveCapabilityParams(
      { ref: '{{triggerParams.branch}}', flag: '{{vars.enabled}}', lit: 'plain' },
      { branch: 'main' },
      { enabled: true },
    )
    const twice = resolveCapabilityParams(once, { branch: 'main' }, { enabled: true })
    expect(twice).toEqual(once)
    expect(twice).toEqual({ ref: 'main', flag: true, lit: 'plain' })
  })

  it('2-arg overload: re-resolving already-resolved params returns identical structure', () => {
    const ctx = makeCtx({
      steps: { load: { status: 'success', output: { id: 7 } } },
      triggerParams: { branch: 'main' },
    })
    const once = resolveCapabilityParams(
      { uid: '{{steps.load.output.id}}', ref: '{{triggerParams.branch}}', lit: 'x' },
      ctx,
    )
    const twice = resolveCapabilityParams(once, ctx)
    expect(twice).toEqual(once)
    expect(twice).toEqual({ uid: 7, ref: 'main', lit: 'x' })
  })

  it('non-string resolved values stay non-string after second resolve', () => {
    const ctx = makeCtx({
      steps: { q: { status: 'success', output: { rows: [1, 2, 3] } } },
    })
    const once = resolveCapabilityParams({ rows: '{{steps.q.output.rows}}' }, ctx)
    const twice = resolveCapabilityParams(once, ctx)
    expect(once).toEqual({ rows: [1, 2, 3] })
    expect(twice).toEqual({ rows: [1, 2, 3] })
  })
})
