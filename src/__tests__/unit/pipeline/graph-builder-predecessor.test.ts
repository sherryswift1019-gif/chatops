import { describe, it, expect } from 'vitest'
import { findPredecessorStageName } from '../../../pipeline/graph-builder.js'
import type { PipelineGraph } from '../../../pipeline/types.js'

describe('findPredecessorStageName', () => {
  it('returns predecessor LangGraph stage name for middle node', () => {
    const pipeline: PipelineGraph = {
      nodes: [
        { id: 'init_branch', stageType: 'llm_author', targetRoles: [], stageIndex: 0 } as any,
        { id: 'spec_ai_review', stageType: 'llm_author', targetRoles: [], stageIndex: 1 } as any,
      ],
      edges: [
        { id: 'e1', source: 'init_branch', target: 'spec_ai_review' },
      ],
    }

    const result = findPredecessorStageName(pipeline, 'spec_ai_review')
    expect(result).toBe('stage_0_llm_author')
  })

  it('returns null for entry node (no predecessor)', () => {
    const pipeline: PipelineGraph = {
      nodes: [
        { id: 'init_branch', stageType: 'llm_author', targetRoles: [], stageIndex: 0 } as any,
      ],
      edges: [],
    }

    const result = findPredecessorStageName(pipeline, 'init_branch')
    expect(result).toBeNull()
  })

  it('returns null for unknown node id', () => {
    const pipeline: PipelineGraph = {
      nodes: [
        { id: 'init_branch', stageType: 'llm_author', targetRoles: [], stageIndex: 0 } as any,
      ],
      edges: [],
    }

    const result = findPredecessorStageName(pipeline, 'nonexistent_node')
    expect(result).toBeNull()
  })

  it('picks first predecessor when multiple', () => {
    const pipeline: PipelineGraph = {
      nodes: [
        { id: 'a', stageType: 'llm_author', targetRoles: [], stageIndex: 0 } as any,
        { id: 'b', stageType: 'script', targetRoles: [], stageIndex: 1 } as any,
        { id: 'c', stageType: 'dm', targetRoles: [], stageIndex: 2 } as any,
      ],
      edges: [
        { id: 'e1', source: 'a', target: 'c' },
        { id: 'e2', source: 'b', target: 'c' },
      ],
    }

    const result = findPredecessorStageName(pipeline, 'c')
    // picks first edge (e1), source = 'a', index 0, stageType 'llm_author'
    expect(result).toBe('stage_0_llm_author')
  })
})
