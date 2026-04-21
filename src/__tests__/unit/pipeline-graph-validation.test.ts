import { describe, it, expect } from 'vitest'
import { validatePipelineGraph } from '../../pipeline/graph-validation.js'
import type { PipelineGraph } from '../../pipeline/types.js'

function node(id: string, name = id): PipelineGraph['nodes'][number] {
  return {
    id, name, stageType: 'script', script: 'true',
    targetRoles: [], parallel: false, timeoutSeconds: 60,
    retryCount: 0, onFailure: 'stop',
    position: { x: 0, y: 0 },
  }
}
function edge(id: string, source: string, target: string): PipelineGraph['edges'][number] {
  return { id, source, target }
}

describe('validatePipelineGraph', () => {
  it('空图视为合法（允许保存未完成的 draft）', () => {
    expect(validatePipelineGraph({ nodes: [], edges: [] }).ok).toBe(true)
  })

  it('单节点 + 0 边合法', () => {
    expect(validatePipelineGraph({ nodes: [node('a')], edges: [] }).ok).toBe(true)
  })

  it('线性链合法', () => {
    const g = { nodes: [node('a'), node('b'), node('c')], edges: [edge('e1', 'a', 'b'), edge('e2', 'b', 'c')] }
    expect(validatePipelineGraph(g).ok).toBe(true)
  })

  it('节点 id 重复：报错', () => {
    const g = { nodes: [node('a'), node('a', 'dup')], edges: [] }
    const r = validatePipelineGraph(g)
    expect(r.ok).toBe(false)
    expect(r.errors.some(e => e.includes('duplicate'))).toBe(true)
  })

  it('悬挂 edge（指向不存在节点）：报错', () => {
    const g = { nodes: [node('a')], edges: [edge('e1', 'a', 'ghost')] }
    const r = validatePipelineGraph(g)
    expect(r.ok).toBe(false)
    expect(r.errors.some(e => e.includes('ghost'))).toBe(true)
  })

  it('cycle：报错', () => {
    const g = {
      nodes: [node('a'), node('b'), node('c')],
      edges: [edge('e1', 'a', 'b'), edge('e2', 'b', 'c'), edge('e3', 'c', 'a')],
    }
    const r = validatePipelineGraph(g)
    expect(r.ok).toBe(false)
    expect(r.errors.some(e => e.toLowerCase().includes('cycle'))).toBe(true)
  })

  it('多个独立子图警告（不阻塞）：ok=true', () => {
    const g = { nodes: [node('a'), node('b')], edges: [] }
    expect(validatePipelineGraph(g).ok).toBe(true)
  })

  it('condition.kind=expression 需要非空 expression', () => {
    const g: PipelineGraph = {
      nodes: [node('a'), node('b')],
      edges: [{ id: 'e', source: 'a', target: 'b', condition: { kind: 'expression', expression: '' } }],
    }
    const r = validatePipelineGraph(g)
    expect(r.ok).toBe(false)
    expect(r.errors.some(e => e.includes('expression'))).toBe(true)
  })
})
