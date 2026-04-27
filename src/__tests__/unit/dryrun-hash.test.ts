import { describe, it, expect } from 'vitest'
import { computeUpstreamHash } from '../../pipeline/dryrun-hash.js'
import type { PipelineGraph } from '../../pipeline/types.js'

function makeNode(id: string, stageType: string, params?: unknown): PipelineGraph['nodes'][number] {
  return {
    id, name: id, stageType: stageType as any, params: params as any,
    targetRoles: [], parallel: false, timeoutSeconds: 60,
    retryCount: 0, onFailure: 'stop', position: { x: 0, y: 0 },
  } as PipelineGraph['nodes'][number]
}

describe('computeUpstreamHash', () => {
  const baseGraph: PipelineGraph = {
    nodes: [
      makeNode('a', 'sql_query', { sqlTemplate: 'SELECT 1' }),
      makeNode('b', 'http', { url: 'http://x' }),
      makeNode('c', 'switch', { cases: [], default: 'a' }),
    ],
    edges: [
      { id: 'e1', source: 'a', target: 'b' },
      { id: 'e2', source: 'b', target: 'c' },
    ],
  }

  it('同一 graph 同一 target 节点：hash 稳定', () => {
    const h1 = computeUpstreamHash(baseGraph, 'c')
    const h2 = computeUpstreamHash(baseGraph, 'c')
    expect(h1).toBe(h2)
  })

  it('不同 target 节点：hash 不同', () => {
    const ha = computeUpstreamHash(baseGraph, 'b')  // ancestor: {a}
    const hc = computeUpstreamHash(baseGraph, 'c')  // ancestor: {a, b}
    expect(ha).not.toBe(hc)
  })

  it('改 ancestor params：hash 变', () => {
    const g2 = { ...baseGraph, nodes: baseGraph.nodes.map(n =>
      n.id === 'a' ? { ...n, params: { sqlTemplate: 'SELECT 2' } } : n) }
    expect(computeUpstreamHash(baseGraph, 'c')).not.toBe(computeUpstreamHash(g2, 'c'))
  })

  it('改 retryCount/timeoutSeconds：hash 不变（不进 hash）', () => {
    const g2 = { ...baseGraph, nodes: baseGraph.nodes.map(n =>
      n.id === 'a' ? { ...n, retryCount: 99, timeoutSeconds: 999 } : n) }
    expect(computeUpstreamHash(baseGraph, 'c')).toBe(computeUpstreamHash(g2, 'c'))
  })

  it('改 position：hash 不变', () => {
    const g2 = { ...baseGraph, nodes: baseGraph.nodes.map(n =>
      n.id === 'a' ? { ...n, position: { x: 999, y: 999 } } : n) }
    expect(computeUpstreamHash(baseGraph, 'c')).toBe(computeUpstreamHash(g2, 'c'))
  })

  it('改上游 edge condition：hash 变', () => {
    const g2 = { ...baseGraph, edges: baseGraph.edges.map(e =>
      e.id === 'e1' ? { ...e, condition: { kind: 'expression' as const, expression: 'true' } } : e) }
    expect(computeUpstreamHash(baseGraph, 'c')).not.toBe(computeUpstreamHash(g2, 'c'))
  })
})
