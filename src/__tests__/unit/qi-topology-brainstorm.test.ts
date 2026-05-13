import { describe, it, expect } from 'vitest'
import { buildQuickImplGraph } from '../../quick-impl/bootstrap.js'

describe('QI topology with spec_brainstorm', () => {
  it('has spec_brainstorm node between init_branch and spec_author', () => {
    const { nodes, edges } = buildQuickImplGraph()
    const brainstorm = nodes.find(n => n.id === 'spec_brainstorm')
    expect(brainstorm).toBeDefined()
    expect((brainstorm as any).stageType).toBe('llm_brainstorm')

    const initToBrainstorm = edges.find(e => e.source === 'init_branch' && e.target === 'spec_brainstorm')
    const brainstormToAuthor = edges.find(e => e.source === 'spec_brainstorm' && e.target === 'spec_author')
    expect(initToBrainstorm).toBeDefined()
    expect(brainstormToAuthor).toBeDefined()
  })

  it('removes the old direct init_branch → spec_author edge', () => {
    const { edges } = buildQuickImplGraph()
    const direct = edges.find(e => e.source === 'init_branch' && e.target === 'spec_author')
    expect(direct).toBeUndefined()
  })

  it('spec_brainstorm node has required params (skill, role, maxRounds, requirementId)', () => {
    const { nodes } = buildQuickImplGraph()
    const bs = nodes.find(n => n.id === 'spec_brainstorm') as any
    expect(bs?.params?.skill).toBe('quick-impl-artifact-author')
    expect(bs?.params?.role).toBe('brainstorm-host')
    expect(bs?.params?.maxRounds).toBe(5)
    expect(bs?.params?.requirementId).toMatch(/triggerParams.requirementId/)
  })
})
