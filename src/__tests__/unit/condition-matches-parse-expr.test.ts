import { describe, it, expect } from 'vitest'
// 注：conditionMatches 当前是 graph-builder 内部 function，需要 export 或通过 buildGraphFromStages 间接测
// 此处假设 Task 5 Step 3 把 conditionMatches export 出来用于测试
import { conditionMatches } from '../../pipeline/graph-builder.js'

const baseState = {
  stageResults: [],
  stepOutputs: { upstream: { status: 'success' as const, output: { score: 90 } } },
  runtimeVars: {},
  currentStageIndex: 0,
} as any

describe('conditionMatches (parseExpression 引擎)', () => {
  it('onSuccess kind', () => {
    const r = { status: 'success', name: 'x', output: '' } as any
    expect(conditionMatches({ kind: 'onSuccess' } as any, r, baseState, {})).toBe(true)
    expect(conditionMatches({ kind: 'onSuccess' } as any, { ...r, status: 'failed' }, baseState, {})).toBe(false)
  })

  it("expression: status == 'success' 等价 onSuccess", () => {
    const r = { status: 'success', name: 'x', output: '' } as any
    expect(conditionMatches({ kind: 'expression', expression: "status == 'success'" } as any, r, baseState, {})).toBe(true)
  })

  it("expression: output contains 'foo' 等价旧 .includes", () => {
    const r = { status: 'success', name: 'x', output: 'hello foo bar' } as any
    expect(conditionMatches({ kind: 'expression', expression: "output contains 'foo'" } as any, r, baseState, {})).toBe(true)
  })

  it('expression 能访问 stepOutputs', () => {
    const r = { status: 'success', name: 'x', output: '' } as any
    expect(conditionMatches({ kind: 'expression', expression: 'steps.upstream.output.score > 80' } as any, r, baseState, {})).toBe(true)
  })

  it('解析失败 / 求值失败 统一返回 false（不抛）', () => {
    const r = { status: 'success', name: 'x', output: '' } as any
    expect(conditionMatches({ kind: 'expression', expression: '+++' } as any, r, baseState, {})).toBe(false)
    expect(conditionMatches({ kind: 'expression', expression: 'steps.nonexistent.deep.path > 0' } as any, r, baseState, {})).toBe(false)
  })
})
