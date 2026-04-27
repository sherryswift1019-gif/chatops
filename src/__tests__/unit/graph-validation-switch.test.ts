import { describe, it, expect } from 'vitest'
import { validatePipelineGraph } from '../../pipeline/graph-validation.js'

function buildGraph(nodes: any[], edges: any[] = []) {
  return { nodes, edges }
}

describe('graph-validation switch + outputFormat + expression', () => {
  it('cases 非数组 → 报错', () => {
    const { errors } = validatePipelineGraph(buildGraph([
      { id: 's', stageType: 'switch', params: { cases: 'foo', default: 'x' }, name: 's', targetRoles: [], parallel: false, timeoutSeconds: 60, retryCount: 0, onFailure: 'stop', position: { x: 0, y: 0 } },
      { id: 'x', stageType: 'sql_query', name: 'x', targetRoles: [], parallel: false, timeoutSeconds: 60, retryCount: 0, onFailure: 'stop', position: { x: 0, y: 0 } },
    ]))
    expect(errors.some(e => e.includes('cases'))).toBe(true)
  })

  it('cases 空数组 → 报错', () => {
    const { errors } = validatePipelineGraph(buildGraph([
      { id: 's', stageType: 'switch', params: { cases: [], default: 'x' }, name: 's', targetRoles: [], parallel: false, timeoutSeconds: 60, retryCount: 0, onFailure: 'stop', position: { x: 0, y: 0 } },
      { id: 'x', stageType: 'sql_query', name: 'x', targetRoles: [], parallel: false, timeoutSeconds: 60, retryCount: 0, onFailure: 'stop', position: { x: 0, y: 0 } },
    ]))
    expect(errors.some(e => e.includes('cases'))).toBe(true)
  })

  it('default 缺失 → 报错', () => {
    const { errors } = validatePipelineGraph(buildGraph([
      { id: 's', stageType: 'switch', params: { cases: [{ when: 'true', target: 'x' }] }, name: 's', targetRoles: [], parallel: false, timeoutSeconds: 60, retryCount: 0, onFailure: 'stop', position: { x: 0, y: 0 } },
      { id: 'x', stageType: 'sql_query', name: 'x', targetRoles: [], parallel: false, timeoutSeconds: 60, retryCount: 0, onFailure: 'stop', position: { x: 0, y: 0 } },
    ]))
    expect(errors.some(e => e.includes('default'))).toBe(true)
  })

  it('target 指向不存在节点 → 报错', () => {
    const { errors } = validatePipelineGraph(buildGraph([
      { id: 's', stageType: 'switch', params: { cases: [{ when: 'true', target: 'nonexistent' }], default: 'x' }, name: 's', targetRoles: [], parallel: false, timeoutSeconds: 60, retryCount: 0, onFailure: 'stop', position: { x: 0, y: 0 } },
      { id: 'x', stageType: 'sql_query', name: 'x', targetRoles: [], parallel: false, timeoutSeconds: 60, retryCount: 0, onFailure: 'stop', position: { x: 0, y: 0 } },
    ]))
    expect(errors.some(e => e.includes('nonexistent'))).toBe(true)
  })

  it('target 自环（target === switchId）→ 报错', () => {
    const { errors } = validatePipelineGraph(buildGraph([
      { id: 's', stageType: 'switch', params: { cases: [{ when: 'true', target: 's' }], default: 'x' }, name: 's', targetRoles: [], parallel: false, timeoutSeconds: 60, retryCount: 0, onFailure: 'stop', position: { x: 0, y: 0 } },
      { id: 'x', stageType: 'sql_query', name: 'x', targetRoles: [], parallel: false, timeoutSeconds: 60, retryCount: 0, onFailure: 'stop', position: { x: 0, y: 0 } },
    ]))
    expect(errors.some(e => e.includes('自己'))).toBe(true)
  })

  it('cases[i].when 语法错 → 报错', () => {
    const { errors } = validatePipelineGraph(buildGraph([
      { id: 's', stageType: 'switch', params: { cases: [{ when: '+++', target: 'x' }], default: 'x' }, name: 's', targetRoles: [], parallel: false, timeoutSeconds: 60, retryCount: 0, onFailure: 'stop', position: { x: 0, y: 0 } },
      { id: 'x', stageType: 'sql_query', name: 'x', targetRoles: [], parallel: false, timeoutSeconds: 60, retryCount: 0, onFailure: 'stop', position: { x: 0, y: 0 } },
    ]))
    expect(errors.some(e => e.includes('cases[0].when'))).toBe(true)
  })

  it('outputFormat 非 enum → 报错', () => {
    const { errors } = validatePipelineGraph(buildGraph([
      { id: 'q', stageType: 'llm_agent', capabilityKey: 'k', outputFormat: 'xml' as any, name: 'q', targetRoles: [], parallel: false, timeoutSeconds: 60, retryCount: 0, onFailure: 'stop', position: { x: 0, y: 0 } },
    ]))
    expect(errors.some(e => e.includes('outputFormat'))).toBe(true)
  })

  it('edge.condition.expression 语法错 → 报错', () => {
    const { errors } = validatePipelineGraph(buildGraph(
      [
        { id: 'a', stageType: 'sql_query', name: 'a', targetRoles: [], parallel: false, timeoutSeconds: 60, retryCount: 0, onFailure: 'stop', position: { x: 0, y: 0 } },
        { id: 'b', stageType: 'sql_query', name: 'b', targetRoles: [], parallel: false, timeoutSeconds: 60, retryCount: 0, onFailure: 'stop', position: { x: 0, y: 0 } },
      ],
      [{ id: 'e1', source: 'a', target: 'b', condition: { kind: 'expression', expression: '+++' } }],
    ))
    expect(errors.some(e => e.includes('expression'))).toBe(true)
  })
})
