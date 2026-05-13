/**
 * QI v18 graph 结构 + e2e fix-loop 子机集成测试
 *
 * 不依赖真实 DB / Claude / Playwright — 验证 v18 graph 的关键结构性不变量：
 *   1. 所有必需节点存在（qi_e2e_runner / im_input / dev_fix_author / 各 router / spec_brainstorm）
 *   2. 边连接正确（qi_e2e_runner → e2e_router；router 4 个 case；fix-loop 闭环；intervention 路由）
 *   3. switch case 引用的 target 都是合法节点 id
 *   4. inputs 模板正确传递 spec / failureReport / humanNote 给 dev-loop
 *   5. QUICK_IMPL_TEMPLATE_VERSION = 18
 *
 * 真实端到端跑（含 docker sandbox + Claude）由人工 calibration（≥3 条真实需求）覆盖，
 * 不在自动化测试范围。
 */
import { describe, it, expect } from 'vitest'
import * as bootstrap from '../../quick-impl/bootstrap.js'

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

async function loadV18Graph(): Promise<Graph> {
  capturedGraph = null
  await bootstrap.bootstrapQuickImpl()
  expect(capturedGraph).not.toBeNull()
  return capturedGraph as Graph
}

describe('QI v18 graph 结构 + fix-loop 子机', () => {
  it('QUICK_IMPL_TEMPLATE_VERSION = 18', () => {
    expect(bootstrap.QUICK_IMPL_TEMPLATE_VERSION).toBe(18)
  })

  it('必需节点全部存在', async () => {
    const g = await loadV18Graph()
    const ids = new Set(g.nodes.map((n) => n.id))

    const required = [
      'init_branch',
      'spec_brainstorm',
      'spec_author',
      'spec_ai_review',
      'spec_human_gate',
      'spec_commit_push',
      'plan_author',
      'plan_ai_review',
      'plan_human_gate',
      'plan_commit_push',
      'dev_author',
      'dev_ai_review',
      'dev_human_gate',
      'dev_push',
      'e2e_skip_router',
      'qi_e2e_runner',
      'e2e_router',
      'dev_fix_author',
      'dev_fix_ai_review',
      'e2e_im_intervention',
      'e2e_intervention_router',
      'e2e_sandbox_intervention',
      'sandbox_intervention_router',
      'final_approval',
      'mr_create',
      'cleanup',
      'done',
    ]
    for (const id of required) {
      expect(ids.has(id), `missing node ${id}`).toBe(true)
    }
  })

  it('旧节点（v9）不再出现在 v18 graph', async () => {
    const g = await loadV18Graph()
    const ids = g.nodes.map((n) => n.id)
    expect(ids).not.toContain('spec_review_loop')
    expect(ids).not.toContain('dev_with_review_loop')
    expect(ids).not.toContain('dev_loop_for_e2e_fix')
    expect(ids).not.toContain('plan_human_escalation')
    expect(ids).not.toContain('mr_create_skip')
    expect(ids).not.toContain('e2e_stub')
  })

  it('线性主链：init → spec_brainstorm → spec_author → spec_ai_review → spec_human_gate → spec_commit_push → plan_author', async () => {
    const g = await loadV18Graph()
    const linearChain = ['init_branch', 'spec_brainstorm', 'spec_author', 'spec_ai_review', 'spec_human_gate', 'spec_commit_push', 'plan_author']
    for (let i = 0; i < linearChain.length - 1; i++) {
      const has = g.edges.some((e) => e.source === linearChain[i] && e.target === linearChain[i + 1])
      expect(has, `edge ${linearChain[i]} → ${linearChain[i + 1]} missing`).toBe(true)
    }
  })

  it('dev_push → e2e_skip_router → qi_e2e_runner → e2e_router 连通', async () => {
    const g = await loadV18Graph()
    expect(g.edges.some((e) => e.source === 'dev_push' && e.target === 'e2e_skip_router')).toBe(true)
    expect(g.edges.some((e) => e.source === 'e2e_skip_router' && e.target === 'qi_e2e_runner')).toBe(true)
    expect(g.edges.some((e) => e.source === 'qi_e2e_runner' && e.target === 'e2e_router')).toBe(true)
  })

  it('e2e_router 是 switch 节点，4 个 case 分别指向 final_approval / e2e_sandbox_intervention / dev_fix_author / e2e_im_intervention(default)', async () => {
    const g = await loadV18Graph()
    const router = g.nodes.find((n) => n.id === 'e2e_router')
    expect(router?.stageType).toBe('switch')

    const params = router?.params as { cases: Array<{ when: string; target: string }>; default: string }
    const targets = new Set([...params.cases.map((c) => c.target), params.default])

    expect(targets.has('final_approval')).toBe(true)
    expect(targets.has('e2e_sandbox_intervention')).toBe(true)
    expect(targets.has('dev_fix_author')).toBe(true)
    expect(targets.has('e2e_im_intervention')).toBe(true)

    // 验证 case 表达式
    expect(params.cases.some((c) => c.when.includes("result == 'pass'"))).toBe(true)
    expect(params.cases.some((c) => c.when.includes("result == 'sandbox_failed'"))).toBe(true)
    expect(params.cases.some((c) => c.when.includes("attempt < 2"))).toBe(true)
  })

  it('fix-loop 闭环：dev_fix_author → dev_fix_ai_review → qi_e2e_runner', async () => {
    const g = await loadV18Graph()
    expect(
      g.edges.some((e) => e.source === 'dev_fix_author' && e.target === 'dev_fix_ai_review'),
      'dev_fix_author should go to dev_fix_ai_review',
    ).toBe(true)
    expect(
      g.edges.some((e) => e.source === 'dev_fix_ai_review' && e.target === 'qi_e2e_runner'),
      'dev_fix_ai_review should loop back to qi_e2e_runner',
    ).toBe(true)
  })

  it('e2e_im_intervention 是 im_input 节点 kind=qi_e2e_intervention，3 决策路由', async () => {
    const g = await loadV18Graph()
    const node = g.nodes.find((n) => n.id === 'e2e_im_intervention')
    expect(node?.stageType).toBe('im_input')
    expect((node?.params as { kind?: string }).kind).toBe('qi_e2e_intervention')

    const router = g.nodes.find((n) => n.id === 'e2e_intervention_router')
    expect(router?.stageType).toBe('switch')
    const params = router?.params as { cases: Array<{ when: string; target: string }>; default: string }

    expect(params.cases.some((c) => c.when.includes('force_passed') && c.target === 'final_approval')).toBe(true)
    expect(params.cases.some((c) => c.when.includes("'fix'") && c.target === 'dev_fix_author')).toBe(true)
  })

  it('e2e_sandbox_intervention 是 im_input 节点 kind=qi_sandbox_failed，2 决策路由', async () => {
    const g = await loadV18Graph()
    const node = g.nodes.find((n) => n.id === 'e2e_sandbox_intervention')
    expect(node?.stageType).toBe('im_input')
    expect((node?.params as { kind?: string }).kind).toBe('qi_sandbox_failed')

    const router = g.nodes.find((n) => n.id === 'sandbox_intervention_router')
    expect(router?.stageType).toBe('switch')
    const params = router?.params as { cases: Array<{ when: string; target: string }>; default: string }

    expect(params.cases.some((c) => c.when.includes("'fix'") && c.target === 'qi_e2e_runner')).toBe(true)
  })

  it('所有 switch case 的 target 都引用合法节点 id', async () => {
    const g = await loadV18Graph()
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

  it('dev_fix_author 的 inputs 含 failureReport / humanNote / spec / attempt / mode=e2e_fix', async () => {
    const g = await loadV18Graph()
    const node = g.nodes.find((n) => n.id === 'dev_fix_author')
    expect(node?.stageType).toBe('llm_author')
    const inputs = (node?.params as { inputs?: Record<string, unknown> }).inputs
    expect(inputs).toBeDefined()
    expect(inputs!.failureReport).toBe('{{steps.qi_e2e_runner.output.failureReport}}')
    expect(inputs!.humanNote).toBe('{{steps.e2e_im_intervention.output.humanNote}}')
    expect(inputs!.spec).toBe('{{steps.spec_author.output.skillOutput}}')
    expect(inputs!.attempt).toBe('{{steps.qi_e2e_runner.output.attempt}}')
    expect(inputs!.mode).toBe('e2e_fix')
  })

  it('dev_author inputs 把 spec / plan 完整对象喂给 dev-loop', async () => {
    const g = await loadV18Graph()
    const node = g.nodes.find((n) => n.id === 'dev_author')
    const inputs = (node?.params as { inputs?: Record<string, unknown> }).inputs
    expect(inputs).toBeDefined()
    expect(inputs!.spec).toBe('{{steps.spec_author.output.skillOutput}}')
    expect(inputs!.plan).toBe('{{steps.plan_author.output.skillOutput}}')
  })

  it('qi_e2e_runner 节点参数引用 init_branch.output.bareRepoPath', async () => {
    const g = await loadV18Graph()
    const node = g.nodes.find((n) => n.id === 'qi_e2e_runner')
    expect(node?.stageType).toBe('qi_e2e_runner')
    const params = node?.params as Record<string, unknown>
    expect(params.bareRepoPath).toBe('{{steps.init_branch.output.bareRepoPath}}')
    expect(params.worktreePath).toBe('{{steps.init_branch.output.worktreePath}}')
    expect(params.branch).toBe('{{steps.init_branch.output.branch}}')
  })

  it('final_approval → mr_create 是终态线性边', async () => {
    const g = await loadV18Graph()
    const has = g.edges.some((e) => e.source === 'final_approval' && e.target === 'mr_create')
    expect(has).toBe(true)
  })

  it('cleanup → done 与 mr_create → done 都存在', async () => {
    const g = await loadV18Graph()
    expect(g.edges.some((e) => e.source === 'cleanup' && e.target === 'done')).toBe(true)
    expect(g.edges.some((e) => e.source === 'mr_create' && e.target === 'done')).toBe(true)
  })

  it('各 human_gate 审批拒绝时走 cleanup 分支', async () => {
    const g = await loadV18Graph()
    for (const gate of ['spec_human_gate', 'plan_human_gate', 'dev_human_gate', 'final_approval']) {
      const hasCleanupEdge = g.edges.some((e) => e.source === gate && e.target === 'cleanup')
      expect(hasCleanupEdge, `${gate} should have edge to cleanup`).toBe(true)
    }
  })
})
