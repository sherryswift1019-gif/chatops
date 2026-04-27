import { describe, it, expect } from 'vitest'
import '../../pipeline/node-types/switch.js'
import { getExecutor } from '../../pipeline/node-types/registry.js'

const executor = getExecutor('switch')!
const baseCtx = {
  runId: 1, pipelineId: 1, nodeId: 'sw1',
  triggerParams: {}, vars: {},
  steps: { q: { status: 'success' as const, output: { score: 90, intent: 'rollback' } } },
}

describe('switch node executor', () => {
  it('命中第一个 case → matchedCaseIndex=0', async () => {
    const r = await executor.execute({
      cases: [
        { when: "steps.q.output.intent == 'rollback'", target: 't1' },
        { when: "steps.q.output.score > 50", target: 't2' },
      ],
      default: 'tD',
    }, baseCtx)
    expect(r.status).toBe('success')
    expect(r.output).toEqual({ matchedCaseIndex: 0, matchedTarget: 't1', matchedWhen: "steps.q.output.intent == 'rollback'" })
  })

  it('first-match-wins：多 case 同时 true 取第一个', async () => {
    const r = await executor.execute({
      cases: [
        { when: 'steps.q.output.score > 80', target: 't1' },
        { when: 'steps.q.output.score > 50', target: 't2' },
      ],
      default: 'tD',
    }, baseCtx)
    expect((r.output as any).matchedCaseIndex).toBe(0)
    expect((r.output as any).matchedTarget).toBe('t1')
  })

  it('全 false → 走 default，matchedCaseIndex=null', async () => {
    const r = await executor.execute({
      cases: [{ when: 'steps.q.output.score > 999', target: 't1' }],
      default: 'tD',
    }, baseCtx)
    expect(r.status).toBe('success')
    expect(r.output).toEqual({ matchedCaseIndex: null, matchedTarget: 'tD', matchedWhen: null })
  })

  it('case.when 求值抛错 → status=failed，error 带 case 序号', async () => {
    const r = await executor.execute({
      cases: [{ when: '++++ invalid syntax', target: 't1' }],
      default: 'tD',
    }, baseCtx)
    expect(r.status).toBe('failed')
    expect(r.error).toMatch(/cases\[0\]\.when/)
  })

  it('cases 缺失 → status=failed（运行时兜底，graph-validation 已守门）', async () => {
    const r = await executor.execute({ default: 'tD' } as any, baseCtx)
    expect(r.status).toBe('failed')
  })
})
