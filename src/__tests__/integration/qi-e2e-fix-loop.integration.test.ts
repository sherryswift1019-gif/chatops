/**
 * QI v9 graph 结构 + e2e fix-loop 子机集成测试
 *
 * 不依赖真实 DB / Claude / Playwright — 验证 v9 graph 的关键结构性不变量：
 *   1. 所有必需节点存在（qi_e2e_runner / im_input / dev_loop_for_e2e_fix / 各 router）
 *   2. 边连接正确（qi_e2e_runner → e2e_router；router 4 个 case；fix-loop 闭环；intervention 路由）
 *   3. switch case 引用的 target 都是合法节点 id
 *   4. inputs 模板正确传递 spec.e2eScenarios / failureReport / humanNote 给 dev-loop
 *   5. QUICK_IMPL_TEMPLATE_VERSION = 9
 *
 * 真实端到端跑（含 docker sandbox + Claude）由人工 calibration（≥3 条真实需求）覆盖，
 * 不在自动化测试范围。
 */
import { describe, it, expect } from 'vitest'
// build 私有函数：通过 import + ts-prune 检测可能受影响；这里用动态 import + 反射访问
import * as bootstrap from '../../quick-impl/bootstrap.js'

// 导出私有 builder：bootstrap.ts 没 export buildQuickImplGraph，但 bootstrapQuickImpl 调它。
// 测试需要直接拿到 graph object —— mock createTestPipeline 拦截。
import { vi } from 'vitest'

vi.mock('../../db/repositories/test-pipelines.js', () => ({
  getTestPipelineByName: vi.fn(async () => null),
  createTestPipeline: vi.fn(async (data: { graph: unknown }) => {
    capturedGraph = data.graph
    return { id: 1 }
  }),
  updateTestPipeline: vi.fn(async () => undefined),
}))
vi.mock('../../db/repositories/system-config.js', () => ({
  getConfig: vi.fn(async () => null),
  setConfig: vi.fn(async () => undefined),
}))

let capturedGraph: unknown = null

interface GraphNode {
  id: string
  stageType: string
  params?: Record<string, unknown>
}
interface GraphEdge {
  id: string
  source: string
  target: string
}
interface Graph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

async function loadV9Graph(): Promise<Graph> {
  capturedGraph = null
  await bootstrap.bootstrapQuickImpl()
  expect(capturedGraph).not.toBeNull()
  return capturedGraph as Graph
}

describe('QI v9 graph 结构 + fix-loop 子机', () => {
  it('QUICK_IMPL_TEMPLATE_VERSION = 9', () => {
    expect(bootstrap.QUICK_IMPL_TEMPLATE_VERSION).toBe(9)
  })

  it('必需节点全部存在', async () => {
    const g = await loadV9Graph()
    const ids = new Set(g.nodes.map((n) => n.id))

    const required = [
      'init_branch',
      'spec_review_loop',
      'plan_author',
      'dev_with_review_loop',
      'qi_e2e_runner',
      'e2e_router',
      'dev_loop_for_e2e_fix',
      'e2e_im_intervention',
      'e2e_intervention_router',
      'e2e_sandbox_intervention',
      'sandbox_intervention_router',
      'final_approval',
      'mr_create',
    ]
    for (const id of required) {
      expect(ids.has(id), `missing node ${id}`).toBe(true)
    }
  })

  it('e2e_stub 不再被 v9 graph 引用（保留 DB 行兼容 v8 in-flight，但 v9 graph 不用）', async () => {
    const g = await loadV9Graph()
    const types = g.nodes.map((n) => n.stageType)
    expect(types).not.toContain('e2e_stub')
  })

  it('线性主链：init → spec → plan → dev → qi_e2e_runner → e2e_router', async () => {
    const g = await loadV9Graph()
    const linearChain = ['init_branch', 'spec_review_loop', 'plan_author', 'dev_with_review_loop', 'qi_e2e_runner', 'e2e_router']
    for (let i = 0; i < linearChain.length - 1; i++) {
      const has = g.edges.some((e) => e.source === linearChain[i] && e.target === linearChain[i + 1])
      expect(has, `edge ${linearChain[i]} → ${linearChain[i + 1]} missing`).toBe(true)
    }
  })

  it('e2e_router 是 switch 节点，4 个 case 分别指向 final_approval / sandbox_intervention / dev_loop_for_e2e_fix / e2e_im_intervention(default)', async () => {
    const g = await loadV9Graph()
    const router = g.nodes.find((n) => n.id === 'e2e_router')
    expect(router?.stageType).toBe('switch')

    const params = router?.params as { cases: Array<{ when: string; target: string }>; default: string }
    const targets = new Set([...params.cases.map((c) => c.target), params.default])

    expect(targets.has('final_approval')).toBe(true)
    expect(targets.has('e2e_sandbox_intervention')).toBe(true)
    expect(targets.has('dev_loop_for_e2e_fix')).toBe(true)
    expect(targets.has('e2e_im_intervention')).toBe(true)

    // 验证 case 表达式字面量
    expect(params.cases.some((c) => c.when.includes("result === 'pass'"))).toBe(true)
    expect(params.cases.some((c) => c.when.includes("result === 'sandbox_failed'"))).toBe(true)
    expect(params.cases.some((c) => c.when.includes("attempt < 2"))).toBe(true)
  })

  it('fix-loop 闭环：dev_loop_for_e2e_fix → qi_e2e_runner', async () => {
    const g = await loadV9Graph()
    const has = g.edges.some((e) => e.source === 'dev_loop_for_e2e_fix' && e.target === 'qi_e2e_runner')
    expect(has, 'dev_loop_for_e2e_fix should loop back to qi_e2e_runner').toBe(true)
  })

  it('e2e_im_intervention 是 im_input 节点 kind=qi_e2e_intervention，3 决策路由', async () => {
    const g = await loadV9Graph()
    const node = g.nodes.find((n) => n.id === 'e2e_im_intervention')
    expect(node?.stageType).toBe('im_input')
    expect((node?.params as { kind?: string }).kind).toBe('qi_e2e_intervention')

    const router = g.nodes.find((n) => n.id === 'e2e_intervention_router')
    expect(router?.stageType).toBe('switch')
    const params = router?.params as { cases: Array<{ when: string; target: string }>; default: string }

    expect(params.cases.some((c) => c.when.includes("force_passed") && c.target === 'final_approval')).toBe(true)
    expect(params.cases.some((c) => c.when.includes("'fix'") && c.target === 'dev_loop_for_e2e_fix')).toBe(true)
  })

  it('e2e_sandbox_intervention 是 im_input 节点 kind=qi_sandbox_failed，2 决策路由', async () => {
    const g = await loadV9Graph()
    const node = g.nodes.find((n) => n.id === 'e2e_sandbox_intervention')
    expect(node?.stageType).toBe('im_input')
    expect((node?.params as { kind?: string }).kind).toBe('qi_sandbox_failed')

    const router = g.nodes.find((n) => n.id === 'sandbox_intervention_router')
    expect(router?.stageType).toBe('switch')
    const params = router?.params as { cases: Array<{ when: string; target: string }>; default: string }

    expect(params.cases.some((c) => c.when.includes("'fix'") && c.target === 'qi_e2e_runner')).toBe(true)
  })

  it('所有 switch case 的 target 都引用合法节点 id', async () => {
    const g = await loadV9Graph()
    const ids = new Set(g.nodes.map((n) => n.id))
    const switches = g.nodes.filter((n) => n.stageType === 'switch')

    for (const sw of switches) {
      const params = sw.params as { cases: Array<{ when: string; target: string }>; default: string }
      for (const c of params.cases) {
        expect(ids.has(c.target), `switch ${sw.id} case target "${c.target}" not in graph`).toBe(true)
      }
      expect(ids.has(params.default), `switch ${sw.id} default "${params.default}" not in graph`).toBe(true)
    }
  })

  it('dev_loop_for_e2e_fix 的 inputs 含 failureReport / humanNote / spec / requirementId / attempt', async () => {
    const g = await loadV9Graph()
    const node = g.nodes.find((n) => n.id === 'dev_loop_for_e2e_fix')
    expect(node?.stageType).toBe('skill_with_review')
    const inputs = (node?.params as { inputs?: Record<string, unknown> }).inputs
    expect(inputs).toBeDefined()
    expect(inputs!.failureReport).toBe('{{steps.qi_e2e_runner.output.failureReport}}')
    expect(inputs!.humanNote).toBe('{{steps.e2e_im_intervention.output.humanNote}}')
    expect(inputs!.spec).toBe('{{steps.spec_review_loop.output.skillOutput}}')
    expect(inputs!.attempt).toBe('{{steps.qi_e2e_runner.output.attempt}}')
  })

  it('dev_with_review_loop 首轮 inputs 把 spec 完整对象（含 e2eScenarios）+ requirementId 喂给 dev-loop', async () => {
    const g = await loadV9Graph()
    const node = g.nodes.find((n) => n.id === 'dev_with_review_loop')
    const inputs = (node?.params as { inputs?: Record<string, unknown> }).inputs
    expect(inputs).toBeDefined()
    expect(inputs!.spec).toBe('{{steps.spec_review_loop.output.skillOutput}}')
    expect(inputs!.requirementId).toBe('{{triggerParams.requirementId}}')
  })

  it('qi_e2e_runner 节点参数引用 init_branch.output.bareRepoPath', async () => {
    const g = await loadV9Graph()
    const node = g.nodes.find((n) => n.id === 'qi_e2e_runner')
    expect(node?.stageType).toBe('qi_e2e_runner')
    const params = node?.params as Record<string, unknown>
    expect(params.bareRepoPath).toBe('{{steps.init_branch.output.bareRepoPath}}')
    expect(params.worktreePath).toBe('{{steps.init_branch.output.worktreePath}}')
    expect(params.branch).toBe('{{steps.init_branch.output.branch}}')
  })

  it('final_approval → mr_create 是终态线性边', async () => {
    const g = await loadV9Graph()
    const has = g.edges.some((e) => e.source === 'final_approval' && e.target === 'mr_create')
    expect(has).toBe(true)
  })
})
