import { describe, it, expect } from 'vitest'
import { validatePipelineGraph } from '../../pipeline/graph-validation.js'
import type { PipelineGraph, PipelineNode } from '../../pipeline/types.js'

/**
 * Phase 3 T16 扩展校验：
 *   1) fan_out body 必须非空数组
 *   2) retry_when / shortCircuitWhen 表达式语法预解析
 *   3) {{steps.<id>.output...}} 引用必须指向当前节点的祖先
 *
 * 注意：fan_out / retry_when / shortCircuitWhen / params 都不是 PipelineNode 静态类型上的字段；
 * 通过 `as unknown as PipelineNode` 把 loose 字段挂上去，模拟实际 DB / 画布产生的 graph。
 */
function looseNode(partial: Record<string, unknown>): PipelineNode {
  return {
    targetRoles: [],
    parallel: false,
    timeoutSeconds: 60,
    retryCount: 0,
    onFailure: 'stop',
    position: { x: 0, y: 0 },
    ...partial,
  } as unknown as PipelineNode
}

describe('validatePipelineGraph — Phase 3 T16 扩展', () => {
  describe('fan_out body 校验', () => {
    it('fan_out 节点 没 params.body → 报错', () => {
      const graph: PipelineGraph = {
        nodes: [
          looseNode({
            id: 'f1',
            name: 'fan',
            stageType: 'fan_out',
            params: { source: '{{vars.items}}', as: 'item' },
          }),
        ],
        edges: [],
      }
      const r = validatePipelineGraph(graph)
      expect(r.ok).toBe(false)
      expect(r.errors.some(e => e.includes('f1') && e.includes('non-empty body'))).toBe(true)
    })

    it('fan_out 节点 params.body 是空数组 → 报错', () => {
      const graph: PipelineGraph = {
        nodes: [
          looseNode({
            id: 'f1',
            name: 'fan',
            stageType: 'fan_out',
            params: { source: '{{vars.items}}', as: 'item', body: [] },
          }),
        ],
        edges: [],
      }
      const r = validatePipelineGraph(graph)
      expect(r.ok).toBe(false)
      expect(r.errors.some(e => e.includes('f1') && e.includes('non-empty body'))).toBe(true)
    })

    it('fan_out 节点 body 非空 → 通过', () => {
      const graph: PipelineGraph = {
        nodes: [
          looseNode({
            id: 'f1',
            name: 'fan',
            stageType: 'fan_out',
            params: {
              source: '{{vars.items}}',
              as: 'item',
              body: [{ id: 'b1', nodeTypeKey: 'http', params: { url: 'https://x', method: 'GET' } }],
            },
          }),
        ],
        edges: [],
      }
      const r = validatePipelineGraph(graph)
      expect(r.ok).toBe(true)
    })
  })

  describe('retry_when / shortCircuitWhen 表达式语法预解析', () => {
    it('retry_when 表达式语法错误 → 报错', () => {
      const graph: PipelineGraph = {
        nodes: [
          looseNode({
            id: 's1',
            name: 's',
            stageType: 'script',
            script: 'echo hi',
            retryWhen: 'status == ',
          }),
        ],
        edges: [],
      }
      const r = validatePipelineGraph(graph)
      expect(r.ok).toBe(false)
      expect(r.errors.some(e => e.includes('s1') && e.includes('retry_when 语法错误'))).toBe(true)
    })

    it('retry_when 表达式合法 → 通过', () => {
      const graph: PipelineGraph = {
        nodes: [
          looseNode({
            id: 's1',
            name: 's',
            stageType: 'script',
            script: 'echo hi',
            retryWhen: "status == 'failed'",
          }),
        ],
        edges: [],
      }
      expect(validatePipelineGraph(graph).ok).toBe(true)
    })

    it('shortCircuitWhen 表达式语法错误 → 报错', () => {
      const graph: PipelineGraph = {
        nodes: [
          looseNode({
            id: 's1',
            name: 's',
            stageType: 'script',
            script: 'echo hi',
            params: { shortCircuitWhen: 'output.code ===' },
          }),
        ],
        edges: [],
      }
      const r = validatePipelineGraph(graph)
      expect(r.ok).toBe(false)
      expect(r.errors.some(e => e.includes('s1') && e.includes('shortCircuitWhen 语法错误'))).toBe(true)
    })

    it('shortCircuitWhen 表达式合法 → 通过', () => {
      const graph: PipelineGraph = {
        nodes: [
          looseNode({
            id: 's1',
            name: 's',
            stageType: 'script',
            script: 'echo hi',
            params: { shortCircuitWhen: 'output.code == 0' },
          }),
        ],
        edges: [],
      }
      expect(validatePipelineGraph(graph).ok).toBe(true)
    })
  })

  describe('{{steps.<id>.output...}} 引用 DFS 校验', () => {
    it('引用上游(祖先) step → 通过', () => {
      const graph: PipelineGraph = {
        nodes: [
          looseNode({
            id: 'a',
            name: 'a',
            stageType: 'script',
            script: 'echo a',
          }),
          looseNode({
            id: 'b',
            name: 'b',
            stageType: 'script',
            script: 'echo b',
            params: { script: "echo {{steps.a.output.text}}" },
          }),
        ],
        edges: [{ id: 'e1', source: 'a', target: 'b' }],
      }
      const r = validatePipelineGraph(graph)
      expect(r.ok).toBe(true)
    })

    it('引用下游(非祖先) step → 报错', () => {
      const graph: PipelineGraph = {
        nodes: [
          looseNode({
            id: 'a',
            name: 'a',
            stageType: 'script',
            script: 'echo a',
            params: { script: "echo {{steps.b.output.text}}" },
          }),
          looseNode({
            id: 'b',
            name: 'b',
            stageType: 'script',
            script: 'echo b',
          }),
        ],
        edges: [{ id: 'e1', source: 'a', target: 'b' }],
      }
      const r = validatePipelineGraph(graph)
      expect(r.ok).toBe(false)
      expect(r.errors.some(e => e.includes('a') && e.includes('non-ancestor'))).toBe(true)
    })

    it('引用不存在的 step → 报错', () => {
      const graph: PipelineGraph = {
        nodes: [
          looseNode({
            id: 'a',
            name: 'a',
            stageType: 'script',
            script: 'echo a',
            params: { script: "echo {{steps.ghost.output.x}}" },
          }),
        ],
        edges: [],
      }
      const r = validatePipelineGraph(graph)
      expect(r.ok).toBe(false)
      expect(r.errors.some(e => e.includes('a') && e.includes('unknown step'))).toBe(true)
    })

    it('引用并行兄弟节点(共同父但非祖先) → 报错', () => {
      // root → a, root → b; a 引用 steps.b.* —— b 不是 a 的祖先
      const graph: PipelineGraph = {
        nodes: [
          looseNode({ id: 'root', name: 'root', stageType: 'script', script: 'echo' }),
          looseNode({
            id: 'a',
            name: 'a',
            stageType: 'script',
            script: 'echo a',
            params: { script: "echo {{steps.b.output.x}}" },
          }),
          looseNode({ id: 'b', name: 'b', stageType: 'script', script: 'echo b' }),
        ],
        edges: [
          { id: 'e1', source: 'root', target: 'a' },
          { id: 'e2', source: 'root', target: 'b' },
        ],
      }
      const r = validatePipelineGraph(graph)
      expect(r.ok).toBe(false)
      expect(r.errors.some(e => e.includes('"a"') && e.includes('non-ancestor') && e.includes('"b"'))).toBe(true)
    })

    it('retry_when 中引用上游 step → 通过', () => {
      const graph: PipelineGraph = {
        nodes: [
          looseNode({ id: 'a', name: 'a', stageType: 'script', script: 'echo' }),
          looseNode({
            id: 'b',
            name: 'b',
            stageType: 'script',
            script: 'echo',
            retryWhen: "steps.a.output.code != 0",
          }),
        ],
        edges: [{ id: 'e1', source: 'a', target: 'b' }],
      }
      expect(validatePipelineGraph(graph).ok).toBe(true)
    })
  })
})
