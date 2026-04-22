import { describe, it, expect } from 'vitest'
import { pruneStageFields, obsoleteFieldsOnSwitch } from './pruneStageFields'
import type { StageFields } from '../types'

function base(type: StageFields['stageType'], extras: Partial<StageFields> = {}): StageFields {
  return {
    id: 'n1',
    name: 'n',
    stageType: type,
    targetRoles: [],
    parallel: false,
    timeoutSeconds: 300,
    retryCount: 0,
    onFailure: 'stop',
    ...extras,
  }
}

describe('pruneStageFields', () => {
  it('script → capability: 清掉 script，注入 capabilityKey/Params 默认值', () => {
    const prev = base('script', { script: 'echo hi' })
    const next = pruneStageFields(prev, 'capability')
    expect(next.script).toBeUndefined()
    expect(next.capabilityKey).toBe('')
    expect(next.capabilityParams).toEqual({})
    expect(next.stageType).toBe('capability')
    expect(next.name).toBe('n')  // 共享字段保留
  })

  it('approval → im_input: 清掉 approverIds，注入 imInputConfig 默认值', () => {
    const prev = base('approval', { approverIds: ['u1'], approvalDescription: 'ok' })
    const next = pruneStageFields(prev, 'im_input')
    expect(next.approverIds).toBeUndefined()
    expect(next.approvalDescription).toBeUndefined()
    expect(next.imInputConfig?.prompt).toBe('请提供以下参数：')
  })

  it('所有独占字段在切换后都存在于返回对象中（undefined 或新默认值），浅合并可覆盖旧值', () => {
    const prev = base('script', {
      script: 'echo hi',
      approverIds: ['u1'],
      capabilityKey: 'old',
      webhookTag: 'old-tag',
    })
    const next = pruneStageFields(prev, 'capability')
    // 独占字段都应该在返回对象里（无论值是 undefined 还是新默认值），这样浅合并才能覆盖
    expect(Object.keys(next)).toEqual(
      expect.arrayContaining(['script', 'approverIds', 'approvalDescription', 'webhookTag', 'imInputConfig'])
    )
    expect(next.script).toBeUndefined()
    expect(next.approverIds).toBeUndefined()
    expect(next.webhookTag).toBeUndefined()
    expect(next.imInputConfig).toBeUndefined()
    expect(next.capabilityKey).toBe('')
  })
})

describe('obsoleteFieldsOnSwitch', () => {
  it('prev 是 script(script="x") 切到 capability → 返回 [script]', () => {
    const prev = base('script', { script: 'x' })
    expect(obsoleteFieldsOnSwitch(prev, 'capability')).toEqual(['script'])
  })

  it('prev 是 capability(key/params 都填) 切到 script → 返回 [capabilityKey, capabilityParams]', () => {
    const prev = base('capability', { capabilityKey: 'build', capabilityParams: { a: 1 } })
    expect(obsoleteFieldsOnSwitch(prev, 'script').sort()).toEqual(['capabilityKey', 'capabilityParams'])
  })

  it('空值字段不计入 obsolete', () => {
    const prev = base('capability', { capabilityKey: '', capabilityParams: {} })
    expect(obsoleteFieldsOnSwitch(prev, 'script')).toEqual([])
  })
})
