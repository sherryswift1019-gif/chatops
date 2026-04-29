import { describe, it, expect } from 'vitest'
import { validatePipelineGraph } from '../../pipeline/graph-validation.js'
import type { PipelineGraph, PipelineNode } from '../../pipeline/types.js'

function node(partial: Partial<PipelineNode> & Pick<PipelineNode, 'id' | 'name' | 'stageType'>): PipelineNode {
  return {
    targetRoles: [],
    parallel: false,
    timeoutSeconds: 60,
    retryCount: 0,
    onFailure: 'stop',
    position: { x: 0, y: 0 },
    ...partial,
  }
}

describe('validatePipelineGraph — 按 stageType 必填校验', () => {
  it('capability 节点缺 capabilityKey → 报错', () => {
    const graph: PipelineGraph = {
      nodes: [node({ id: 'n1', name: 'cap', stageType: 'llm_agent' })],
      edges: [],
    }
    const r = validatePipelineGraph(graph)
    expect(r.ok).toBe(false)
    expect(r.errors.some(e => e.includes('n1') && e.includes('capabilityKey'))).toBe(true)
  })

  it('capability 节点有 capabilityKey → 通过', () => {
    const graph: PipelineGraph = {
      nodes: [node({ id: 'n1', name: 'cap', stageType: 'llm_agent', capabilityKey: 'build' })],
      edges: [],
    }
    expect(validatePipelineGraph(graph).ok).toBe(true)
  })

  it('wait_webhook 节点缺 webhookTag → 报错', () => {
    const graph: PipelineGraph = {
      nodes: [node({ id: 'n1', name: 'w', stageType: 'wait_webhook' })],
      edges: [],
    }
    const r = validatePipelineGraph(graph)
    expect(r.ok).toBe(false)
    expect(r.errors.some(e => e.includes('n1') && e.includes('webhookTag'))).toBe(true)
  })

  it('approval 节点缺 approverIds → 报错', () => {
    const graph: PipelineGraph = {
      nodes: [node({ id: 'n1', name: 'a', stageType: 'approval' })],
      edges: [],
    }
    const r = validatePipelineGraph(graph)
    expect(r.ok).toBe(false)
    expect(r.errors.some(e => e.includes('n1') && e.includes('approverIds'))).toBe(true)
  })

  it('approval 节点 approverIds 是空数组 → 报错', () => {
    const graph: PipelineGraph = {
      nodes: [node({ id: 'n1', name: 'a', stageType: 'approval', approverIds: [] })],
      edges: [],
    }
    expect(validatePipelineGraph(graph).ok).toBe(false)
  })

  it('script 节点脚本为空 → 通过（允许占位）', () => {
    const graph: PipelineGraph = {
      nodes: [node({ id: 'n1', name: 's', stageType: 'script' })],
      edges: [],
    }
    expect(validatePipelineGraph(graph).ok).toBe(true)
  })
})
