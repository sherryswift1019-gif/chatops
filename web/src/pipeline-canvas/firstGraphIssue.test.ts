import { describe, it, expect } from 'vitest'
import { firstGraphIssue } from './graph-validation'
import type { StageFields } from './types'

function node(id: string, data: Partial<StageFields> & { stageType: StageFields['stageType'] }) {
  return {
    id,
    data: {
      id,
      name: 'test-node',
      targetRoles: [],
      parallel: false,
      timeoutSeconds: 300,
      retryCount: 0,
      onFailure: 'stop' as const,
      ...data,
    } as StageFields,
  }
}

describe('firstGraphIssue', () => {
  it('llm_agent + capability 模式 + 无 capabilityKey → 报错', () => {
    const result = firstGraphIssue([node('n1', { stageType: 'llm_agent', agentMode: 'capability', capabilityKey: '' })])
    expect(result).not.toBeNull()
    expect(result?.message).toContain('未选择 Capability')
  })

  it('llm_agent + capability 模式 + 有 capabilityKey → 无报错', () => {
    const result = firstGraphIssue([node('n1', { stageType: 'llm_agent', agentMode: 'capability', capabilityKey: 'deploy' })])
    expect(result).toBeNull()
  })

  it('llm_agent + custom 模式 + 无 capabilityKey → 不报错（自定义模式不需要选能力）', () => {
    const result = firstGraphIssue([node('n1', { stageType: 'llm_agent', agentMode: 'custom', capabilityKey: '' })])
    expect(result).toBeNull()
  })

  it('llm_agent + agentMode 未设置 + 无 capabilityKey → 报错（默认行为）', () => {
    const result = firstGraphIssue([node('n1', { stageType: 'llm_agent', capabilityKey: '' })])
    expect(result).not.toBeNull()
    expect(result?.message).toContain('未选择 Capability')
  })

  it('节点缺少名称 → 报错', () => {
    const result = firstGraphIssue([node('n1', { stageType: 'script', name: '' } as any)])
    expect(result).not.toBeNull()
    expect(result?.message).toBe('节点缺少名称')
  })

  it('无节点 → 无报错', () => {
    expect(firstGraphIssue([])).toBeNull()
  })
})
