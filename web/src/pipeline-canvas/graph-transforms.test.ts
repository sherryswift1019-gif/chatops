import { describe, it, expect } from 'vitest'
import { wireToNodes, wireToEdges } from './graph-transforms'
import type { PipelineGraphWire } from './types'

function emptyWire(): PipelineGraphWire {
  return { nodes: [], edges: [] }
}

describe('wireToNodes', () => {
  it('空图返回空数组', () => {
    expect(wireToNodes(emptyWire())).toEqual([])
  })

  it('基础字段映射：id / type / position', () => {
    const wire: PipelineGraphWire = {
      nodes: [{ id: 'n1', stageType: 'script', name: 'build', position: { x: 10, y: 20 }, targetRoles: [], parallel: false, timeoutSeconds: 300, retryCount: 0, onFailure: 'stop' }],
      edges: [],
    }
    const [node] = wireToNodes(wire)
    expect(node.id).toBe('n1')
    expect(node.type).toBe('script')
    expect(node.position).toEqual({ x: 10, y: 20 })
  })

  it('data 透传原始 wire 节点字段', () => {
    const wire: PipelineGraphWire = {
      nodes: [{ id: 'n1', stageType: 'llm_agent', name: '分析', capabilityKey: 'analyze', position: { x: 0, y: 0 }, targetRoles: [], parallel: false, timeoutSeconds: 300, retryCount: 0, onFailure: 'stop' }],
      edges: [],
    }
    const [node] = wireToNodes(wire)
    expect(node.data.stageType).toBe('llm_agent')
    expect(node.data.name).toBe('分析')
    expect((node.data as any).capabilityKey).toBe('analyze')
  })

  it('多节点保持顺序', () => {
    const wire: PipelineGraphWire = {
      nodes: [
        { id: 'a', stageType: 'script', name: 'a', position: { x: 0, y: 0 }, targetRoles: [], parallel: false, timeoutSeconds: 300, retryCount: 0, onFailure: 'stop' },
        { id: 'b', stageType: 'approval', name: 'b', position: { x: 0, y: 0 }, targetRoles: [], parallel: false, timeoutSeconds: 300, retryCount: 0, onFailure: 'stop' },
      ],
      edges: [],
    }
    const nodes = wireToNodes(wire)
    expect(nodes.map(n => n.id)).toEqual(['a', 'b'])
  })
})

describe('wireToEdges', () => {
  it('空图返回空数组', () => {
    expect(wireToEdges(emptyWire())).toEqual([])
  })

  it('普通边：基础字段 + type=conditional', () => {
    const wire: PipelineGraphWire = {
      nodes: [],
      edges: [{ id: 'e1', source: 's1', target: 't1' }],
    }
    const [edge] = wireToEdges(wire)
    expect(edge.id).toBe('e1')
    expect(edge.source).toBe('s1')
    expect(edge.target).toBe('t1')
    expect(edge.type).toBe('conditional')
  })

  it('带 condition 的边：data.condition 有值', () => {
    const cond = { kind: 'expression' as const, expression: 'status == "ok"' }
    const wire: PipelineGraphWire = {
      nodes: [],
      edges: [{ id: 'e1', source: 's', target: 't', condition: cond }],
    }
    const [edge] = wireToEdges(wire)
    expect(edge.data?.condition).toEqual(cond)
  })

  it('sourceHandle="default" 时注入 data.isDefault=true', () => {
    const wire: PipelineGraphWire = {
      nodes: [],
      edges: [{ id: 'e1', source: 's', target: 't', sourceHandle: 'default' }],
    }
    const [edge] = wireToEdges(wire)
    expect(edge.data?.isDefault).toBe(true)
    expect(edge.sourceHandle).toBe('default')
  })

  it('普通 sourceHandle 不注入 isDefault', () => {
    const wire: PipelineGraphWire = {
      nodes: [],
      edges: [{ id: 'e1', source: 's', target: 't', sourceHandle: 'case-0' }],
    }
    const [edge] = wireToEdges(wire)
    expect(edge.data?.isDefault).toBeUndefined()
  })

  it('无 sourceHandle 的边 data 为空对象', () => {
    const wire: PipelineGraphWire = {
      nodes: [],
      edges: [{ id: 'e1', source: 's', target: 't' }],
    }
    const [edge] = wireToEdges(wire)
    expect(edge.data).toEqual({})
  })
})
