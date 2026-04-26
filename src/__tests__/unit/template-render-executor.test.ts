import { describe, it, expect } from 'vitest'
import type { ExecutionContext } from '../../pipeline/node-types/types.js'
import '../../pipeline/node-types/template-render.js'
import { getExecutor } from '../../pipeline/node-types/registry.js'

function makeCtx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    runId: 42,
    pipelineId: 100,
    nodeId: 't1',
    triggerParams: {},
    vars: {},
    steps: {},
    ...overrides,
  }
}

function loadTemplateRenderExecutor() {
  const exec = getExecutor('template_render')
  if (!exec) throw new Error('template_render executor not registered')
  return exec
}

describe('template_render node executor (phase 3 T14)', () => {
  it('renders {{vars.x}} from ctx.vars', async () => {
    const exec = loadTemplateRenderExecutor()
    const result = await exec.execute(
      { template: 'deploy version {{vars.tag}}' },
      makeCtx({ vars: { tag: 'v1.2.3' } }),
    )
    expect(result.status).toBe('success')
    expect((result.output as Record<string, unknown>).text).toBe('deploy version v1.2.3')
  })

  it('renders {{steps.x.output.y}} from ctx.steps', async () => {
    const exec = loadTemplateRenderExecutor()
    const result = await exec.execute(
      { template: 'count={{steps.q1.output.count}}' },
      makeCtx({
        steps: {
          q1: { status: 'success', output: { count: 7 } },
        },
      }),
    )
    expect(result.status).toBe('success')
    expect((result.output as Record<string, unknown>).text).toBe('count=7')
  })

  it('renders {{triggerParams.x}}', async () => {
    const exec = loadTemplateRenderExecutor()
    const result = await exec.execute(
      { template: 'env={{triggerParams.env}}' },
      makeCtx({ triggerParams: { env: 'prod' } }),
    )
    expect(result.status).toBe('success')
    expect((result.output as Record<string, unknown>).text).toBe('env=prod')
  })

  it('params.vars merges into vars namespace and overrides ctx.vars', async () => {
    const exec = loadTemplateRenderExecutor()
    const result = await exec.execute(
      {
        template: 'a={{vars.a}} b={{vars.b}}',
        vars: { a: 'fromParams', c: 'extra' },
      },
      makeCtx({ vars: { a: 'fromCtx', b: 'fromCtxB' } }),
    )
    expect(result.status).toBe('success')
    expect((result.output as Record<string, unknown>).text).toBe('a=fromParams b=fromCtxB')
  })

  it('builtin filter urlEncode applied', async () => {
    const exec = loadTemplateRenderExecutor()
    const result = await exec.execute(
      { template: 'q={{vars.s | urlEncode}}', vars: { s: 'a/b c' } },
      makeCtx(),
    )
    expect(result.status).toBe('success')
    expect((result.output as Record<string, unknown>).text).toBe('q=a%2Fb%20c')
  })

  it('unresolved variable kept as literal {{...}}', async () => {
    const exec = loadTemplateRenderExecutor()
    const result = await exec.execute(
      { template: 'x={{vars.nope}}' },
      makeCtx(),
    )
    expect(result.status).toBe('success')
    expect((result.output as Record<string, unknown>).text).toBe('x={{vars.nope}}')
  })

  it('unknown filter throws → status=failed with error message', async () => {
    const exec = loadTemplateRenderExecutor()
    const result = await exec.execute(
      { template: '{{vars.x | bogusFilter}}', vars: { x: 'v' } },
      makeCtx(),
    )
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/unknown variable filter/)
  })

  it('missing template → failed', async () => {
    const exec = loadTemplateRenderExecutor()
    const result = await exec.execute({}, makeCtx())
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/template/)
  })

  it('empty template renders empty string', async () => {
    const exec = loadTemplateRenderExecutor()
    const result = await exec.execute({ template: '' }, makeCtx())
    expect(result.status).toBe('success')
    expect((result.output as Record<string, unknown>).text).toBe('')
  })
})
