import { describe, it, expect } from 'vitest'
import { validatePipelineGraph } from '../../pipeline/graph-validation.js'
import type { PipelineGraph, PipelineNode } from '../../pipeline/types.js'

function makeNode(overrides: Partial<PipelineNode>): PipelineNode {
  return {
    id: 'node-1',
    position: { x: 0, y: 0 },
    name: 'test',
    stageType: 'llm_agent',
    targetRoles: [],
    parallel: false,
    timeoutSeconds: 60,
    retryCount: 0,
    onFailure: 'stop',
    ...overrides,
  } as PipelineNode
}

describe('llm_agent custom mode validation', () => {
  it('capability 模式：capabilityKey 必填', () => {
    const g: PipelineGraph = { nodes: [makeNode({ agentMode: 'capability' })], edges: [] }
    const r = validatePipelineGraph(g)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toMatch(/capabilityKey/)
  })

  it('capability 模式：capabilityKey 存在则通过', () => {
    const g: PipelineGraph = { nodes: [makeNode({ agentMode: 'capability', capabilityKey: 'deploy' })], edges: [] }
    const r = validatePipelineGraph(g)
    expect(r.valid).toBe(true)
  })

  it('custom 模式：customPrompt 必填', () => {
    const g: PipelineGraph = { nodes: [makeNode({ agentMode: 'custom' })], edges: [] }
    const r = validatePipelineGraph(g)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toMatch(/customPrompt/)
  })

  it('custom 模式：customPrompt 存在则通过，capabilityKey 可为空', () => {
    const g: PipelineGraph = { nodes: [makeNode({ agentMode: 'custom', customPrompt: 'hello' })], edges: [] }
    const r = validatePipelineGraph(g)
    expect(r.valid).toBe(true)
  })

  it('agentMode 缺省时走 capability 路径（向后兼容）', () => {
    const g: PipelineGraph = { nodes: [makeNode({ capabilityKey: 'deploy' })], edges: [] }
    const r = validatePipelineGraph(g)
    expect(r.valid).toBe(true)
  })

  it('custom 模式：customPrompt 空白字符串不通过', () => {
    const g: PipelineGraph = { nodes: [makeNode({ agentMode: 'custom', customPrompt: '   ' })], edges: [] }
    const r = validatePipelineGraph(g)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toMatch(/customPrompt/)
  })
})
