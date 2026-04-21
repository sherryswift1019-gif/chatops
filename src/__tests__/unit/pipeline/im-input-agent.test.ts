import { describe, it, expect } from 'vitest'
import { consultImInputAgent } from '../../../pipeline/im-input-agent.js'

const schema = {
  type: 'object',
  required: ['project', 'env', 'branch'],
  properties: {
    project: { type: 'string', title: '模块' },
    env:     { type: 'string', title: '环境', enum: ['dev', 'staging', 'prod'] },
    branch:  { type: 'string', title: '分支' },
  },
}

describe('consultImInputAgent (heuristic mode)', () => {
  it('marks done when the user message contains all required values in key=value form', async () => {
    const r = await consultImInputAgent({
      userMessage: 'project=web-app env=dev branch=feature/login',
      currentParams: {},
      paramSchema: schema,
    })
    expect(r.done).toBe(true)
    expect(r.params).toEqual({ project: 'web-app', env: 'dev', branch: 'feature/login' })
  })

  it('merges with existing params and completes on the last missing one', async () => {
    const r = await consultImInputAgent({
      userMessage: 'branch=main',
      currentParams: { project: 'api', env: 'dev' },
      paramSchema: schema,
    })
    expect(r.done).toBe(true)
    expect(r.params).toEqual({ project: 'api', env: 'dev', branch: 'main' })
  })

  it('asks for the first missing required param when the message is unparseable', async () => {
    const r = await consultImInputAgent({
      userMessage: '帮我部署一下',
      currentParams: {},
      paramSchema: schema,
    })
    expect(r.done).toBe(false)
    expect(r.nextPrompt).toMatch(/模块|project/)
  })

  it('rejects enum values outside the schema and re-prompts', async () => {
    const r = await consultImInputAgent({
      userMessage: 'env=production',
      currentParams: { project: 'web-app', branch: 'main' },
      paramSchema: schema,
    })
    expect(r.done).toBe(false)
    expect(r.nextPrompt).toMatch(/dev|staging|prod/)
  })

  it('accepts `cancel` / `取消` as explicit abort', async () => {
    const r = await consultImInputAgent({
      userMessage: '取消',
      currentParams: { project: 'web-app' },
      paramSchema: schema,
    })
    expect(r.aborted).toBe(true)
    expect(r.done).toBe(false)
  })

  it('treats a bare value as the single missing required field', async () => {
    const r = await consultImInputAgent({
      userMessage: 'release/2026-04',
      currentParams: { project: 'web-app', env: 'dev' },
      paramSchema: schema,
    })
    expect(r.done).toBe(true)
    expect(r.params.branch).toBe('release/2026-04')
  })

  it('supports quoted values with spaces', async () => {
    const r = await consultImInputAgent({
      userMessage: 'project="user service" env=dev branch=main',
      currentParams: {},
      paramSchema: schema,
    })
    expect(r.done).toBe(true)
    expect(r.params.project).toBe('user service')
  })
})
