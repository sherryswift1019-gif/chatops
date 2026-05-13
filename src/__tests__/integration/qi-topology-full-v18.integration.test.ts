// src/__tests__/integration/qi-topology-full-v18.integration.test.ts
import { describe, it, expect } from 'vitest'
import { buildQuickImplGraph, QUICK_IMPL_TEMPLATE_VERSION } from '../../quick-impl/bootstrap.js'

describe('QI v18 topology (post spec stage upgrade)', () => {
  it('template version is at least 18 (brainstorm + ai_review loop + merge strategy)', () => {
    expect(QUICK_IMPL_TEMPLATE_VERSION).toBeGreaterThanOrEqual(18)
  })

  it('has all expected spec stage nodes', () => {
    const { nodes } = buildQuickImplGraph()
    const ids = nodes.map(n => n.id)
    expect(ids).toContain('init_branch')
    expect(ids).toContain('spec_brainstorm')
    expect(ids).toContain('spec_author')
    expect(ids).toContain('spec_ai_review')
    expect(ids).toContain('spec_human_gate')
    expect(ids).toContain('spec_commit_push')
  })

  it('spec stage edges form expected DAG with conditional ai_review branches', () => {
    const { edges } = buildQuickImplGraph()
    const find = (s: string, t: string) => edges.find(e => e.source === s && e.target === t)

    // init_branch → spec_brainstorm → spec_author
    expect(find('init_branch', 'spec_brainstorm')).toBeDefined()
    expect(find('spec_brainstorm', 'spec_author')).toBeDefined()

    // spec_author → spec_ai_review (single)
    expect(find('spec_author', 'spec_ai_review')).toBeDefined()

    // spec_ai_review conditional branches
    const aiSuccess = find('spec_ai_review', 'spec_human_gate')
    const aiFail = find('spec_ai_review', 'spec_author')
    expect(aiSuccess?.condition?.kind).toBe('onSuccess')
    expect(aiFail?.condition?.kind).toBe('onFailure')

    // spec_human_gate → spec_commit_push (success path)
    expect(find('spec_human_gate', 'spec_commit_push')?.condition?.kind).toBe('onSuccess')

    // spec_commit_push → plan_author
    expect(find('spec_commit_push', 'plan_author')).toBeDefined()
  })

  it('no leftover unconditional spec_ai_review → spec_human_gate edge', () => {
    const { edges } = buildQuickImplGraph()
    const orphan = edges.find(e =>
      e.source === 'spec_ai_review' && e.target === 'spec_human_gate' && !e.condition,
    )
    expect(orphan).toBeUndefined()
  })

  it('no leftover direct init_branch → spec_author edge', () => {
    const { edges } = buildQuickImplGraph()
    const orphan = edges.find(e => e.source === 'init_branch' && e.target === 'spec_author')
    expect(orphan).toBeUndefined()
  })

  it('spec_brainstorm node has llm_brainstorm stageType', () => {
    const { nodes } = buildQuickImplGraph()
    const bs = nodes.find(n => n.id === 'spec_brainstorm') as any
    expect(bs?.stageType).toBe('llm_brainstorm')
  })

  it('spec_ai_review has retryToOnFailure=spec_author param', () => {
    const { nodes } = buildQuickImplGraph()
    const ai = nodes.find(n => n.id === 'spec_ai_review') as any
    expect(ai?.params?.retryToOnFailure).toBe('spec_author')
  })

  it('spec_human_gate has retryToOnReject=spec_author param', () => {
    const { nodes } = buildQuickImplGraph()
    const hg = nodes.find(n => n.id === 'spec_human_gate') as any
    expect(hg?.params?.retryToOnReject).toBe('spec_author')
  })

  it('spec_commit_push has mergeStrategy=preserve-rounds param', () => {
    const { nodes } = buildQuickImplGraph()
    const cp = nodes.find(n => n.id === 'spec_commit_push') as any
    expect(cp?.params?.mergeStrategy).toBe('preserve-rounds')
  })
})
