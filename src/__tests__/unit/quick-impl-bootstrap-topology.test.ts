import { describe, it, expect } from 'vitest'
import { buildQuickImplGraph, QUICK_IMPL_TEMPLATE_VERSION } from '../../quick-impl/bootstrap.js'

describe('quick-impl bootstrap topology', () => {
  const graph = buildQuickImplGraph()

  it('template version 至少为 v14（含 e2e_skip_router）', () => {
    expect(QUICK_IMPL_TEMPLATE_VERSION).toBeGreaterThanOrEqual(14)
  })

  it('包含 e2e_skip_router 节点，且 stageType=switch', () => {
    const node = graph.nodes.find(n => n.id === 'e2e_skip_router')
    expect(node).toBeDefined()
    expect(node?.stageType).toBe('switch')
  })

  it('e2e_skip_router 的 cases 含 skipE2E=true → final_approval，default → qi_e2e_runner', () => {
    const node = graph.nodes.find(n => n.id === 'e2e_skip_router') as unknown as { params: { cases?: Array<{ when?: string; target?: string }>; default?: string } }
    expect(node.params.cases).toEqual([
      { when: 'triggerParams.skipE2E == true', target: 'final_approval' },
    ])
    expect(node.params.default).toBe('qi_e2e_runner')
  })

  it('dev_push 出边指向 e2e_skip_router（不再直连 qi_e2e_runner）', () => {
    const out = graph.edges.filter(e => e.source === 'dev_push').map(e => e.target)
    expect(out).toEqual(['e2e_skip_router'])
  })

  it('e2e_skip_router 出边覆盖 final_approval 与 qi_e2e_runner', () => {
    const out = graph.edges.filter(e => e.source === 'e2e_skip_router').map(e => e.target).sort()
    expect(out).toEqual(['final_approval', 'qi_e2e_runner'])
  })

  it('final_approval.params.artifact 含 skipE2E 占位（审批卡片可见）', () => {
    const node = graph.nodes.find(n => n.id === 'final_approval') as unknown as { params: { artifact?: Record<string, unknown> } }
    expect(node.params.artifact?.skipE2E).toBe('{{triggerParams.skipE2E}}')
  })
})

describe('Quick-Impl bootstrap v16 — reject reroute params', () => {
  it('QUICK_IMPL_TEMPLATE_VERSION bumped to 18 (v18: spec_commit_push mergeStrategy)', () => {
    expect(QUICK_IMPL_TEMPLATE_VERSION).toBe(18)
  })

  it('spec_human_gate.params.retryToOnReject = "spec_author"', () => {
    const g = buildQuickImplGraph()
    const n = g.nodes.find((x) => x.id === 'spec_human_gate')
    expect(n).toBeDefined()
    const params = (n as { params?: Record<string, unknown> }).params ?? {}
    expect(params.retryToOnReject).toBe('spec_author')
  })

  it('plan_human_gate.params.retryToOnReject = "plan_author"', () => {
    const g = buildQuickImplGraph()
    const n = g.nodes.find((x) => x.id === 'plan_human_gate')
    const params = (n as { params?: Record<string, unknown> }).params ?? {}
    expect(params.retryToOnReject).toBe('plan_author')
  })

  it('dev_human_gate.params.retryToOnReject = "dev_author"', () => {
    const g = buildQuickImplGraph()
    const n = g.nodes.find((x) => x.id === 'dev_human_gate')
    const params = (n as { params?: Record<string, unknown> }).params ?? {}
    expect(params.retryToOnReject).toBe('dev_author')
  })

  it('final_approval.params **不含** retryToOnReject（reject = abort 语义）', () => {
    const g = buildQuickImplGraph()
    const n = g.nodes.find((x) => x.id === 'final_approval')
    const params = (n as { params?: Record<string, unknown> }).params ?? {}
    expect(params.retryToOnReject).toBeUndefined()
  })
})
