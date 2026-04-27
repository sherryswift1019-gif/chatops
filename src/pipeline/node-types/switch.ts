import { registerNodeType } from './registry.js'
import { evalExpression } from '../expressions.js'

interface SwitchParams {
  cases?: Array<{ when?: string; target?: string }>
  default?: string
}

registerNodeType({
  key: 'switch',
  async execute(rawParams, ctx) {
    const params = (rawParams ?? {}) as SwitchParams
    const cases = params.cases
    const defaultTarget = params.default

    if (!Array.isArray(cases) || cases.length === 0) {
      return { status: 'failed', output: {}, error: 'switch: cases 必须是非空数组' }
    }
    if (typeof defaultTarget !== 'string' || !defaultTarget.trim()) {
      return { status: 'failed', output: {}, error: 'switch: default 必填' }
    }

    const evalCtx = { steps: ctx.steps, vars: ctx.vars, triggerParams: ctx.triggerParams }

    for (let i = 0; i < cases.length; i++) {
      const c = cases[i]
      if (typeof c?.when !== 'string' || typeof c?.target !== 'string') {
        return { status: 'failed', output: {}, error: `switch: cases[${i}] when/target 必须是字符串` }
      }
      try {
        if (evalExpression(c.when, evalCtx)) {
          return {
            status: 'success',
            output: { matchedCaseIndex: i, matchedTarget: c.target, matchedWhen: c.when },
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return { status: 'failed', output: {}, error: `switch cases[${i}].when 求值错误: ${msg}` }
      }
    }
    return {
      status: 'success',
      output: { matchedCaseIndex: null, matchedTarget: defaultTarget, matchedWhen: null },
    }
  },
})
