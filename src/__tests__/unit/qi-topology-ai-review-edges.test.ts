import { describe, it, expect } from 'vitest'
import { buildQuickImplGraph } from '../../quick-impl/bootstrap.js'

describe('QI spec_ai_review topology edges', () => {
  it('spec_ai_review has onSuccess to spec_human_gate', () => {
    const { edges } = buildQuickImplGraph()
    const e = edges.find(e =>
      e.source === 'spec_ai_review' &&
      e.target === 'spec_human_gate' &&
      e.condition?.kind === 'onSuccess'
    )
    expect(e).toBeDefined()
  })

  it('spec_ai_review has onFailure back to spec_author', () => {
    const { edges } = buildQuickImplGraph()
    const e = edges.find(e =>
      e.source === 'spec_ai_review' &&
      e.target === 'spec_author' &&
      e.condition?.kind === 'onFailure'
    )
    expect(e).toBeDefined()
  })

  it('there is no unconditional spec_ai_review → spec_human_gate edge', () => {
    const { edges } = buildQuickImplGraph()
    const direct = edges.find(e =>
      e.source === 'spec_ai_review' &&
      e.target === 'spec_human_gate' &&
      !e.condition
    )
    expect(direct).toBeUndefined()
  })
})
