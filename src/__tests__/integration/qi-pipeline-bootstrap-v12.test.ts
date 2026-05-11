/**
 * Integration test: Quick-Impl bootstrap v12 新拓扑验证
 *
 * 验证 bootstrapQuickImpl() 把 25 节点新拓扑写入 test_pipelines.graph，
 * 以及 buildGraphFromPipeline 能编译该 graph 而不抛错。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { resetTestDb } from '../helpers/db.js'
import { bootstrapQuickImpl, QUICK_IMPL_PIPELINE_NAME } from '../../quick-impl/bootstrap.js'
import { getTestPipelineByName } from '../../db/repositories/test-pipelines.js'
import { buildGraphFromPipeline, type StageHooks } from '../../pipeline/graph-builder.js'
import type { PipelineGraph } from '../../pipeline/types.js'

const BASE_HOOKS: StageHooks = {
  async runScript() {
    return { status: 'success', output: '' }
  },
}

const BASE_CTX = {
  runId: 9999,
  servers: {} as Record<string, never[]>,
  logDir: '/tmp/qi-bootstrap-test',
  skillExecutor: {
    execute: async () => ({
      rawOutput: '{"decision":"pass","notes":"ok"}',
    }),
  },
}

describe('Quick-Impl bootstrap v12 (new 25-node topology)', () => {
  beforeAll(async () => {
    await resetTestDb()
  })

  it('creates pipeline definition with new topology nodes', async () => {
    await bootstrapQuickImpl()
    const pipeline = await getTestPipelineByName(QUICK_IMPL_PIPELINE_NAME)
    expect(pipeline).toBeDefined()

    const graph = pipeline!.graph as PipelineGraph
    // 用 node.id（小写 kebab-case ID）断言拓扑结构
    const nodeIds = graph.nodes.map(n => n.id)

    // 新拓扑必含的节点（17 个新原子节点 + 保留节点）
    expect(nodeIds).toContain('spec_author')
    expect(nodeIds).toContain('spec_ai_review')
    expect(nodeIds).toContain('spec_human_gate')
    expect(nodeIds).toContain('spec_commit_push')
    expect(nodeIds).toContain('plan_author')
    expect(nodeIds).toContain('plan_ai_review')
    expect(nodeIds).toContain('plan_human_gate')
    expect(nodeIds).toContain('plan_commit_push')
    expect(nodeIds).toContain('dev_author')
    expect(nodeIds).toContain('dev_ai_review')
    expect(nodeIds).toContain('dev_human_gate')
    expect(nodeIds).toContain('dev_push')
    expect(nodeIds).toContain('dev_fix_author')
    expect(nodeIds).toContain('dev_fix_ai_review')
    expect(nodeIds).toContain('final_approval')
    expect(nodeIds).toContain('cleanup')
    expect(nodeIds).toContain('done')

    // 旧节点不应出现
    expect(nodeIds).not.toContain('spec_review_loop')
    expect(nodeIds).not.toContain('plan_review_loop')
    expect(nodeIds).not.toContain('plan_human_escalation')
    expect(nodeIds).not.toContain('dev_with_review_loop')
    expect(nodeIds).not.toContain('dev_loop_for_e2e_fix')
    expect(nodeIds).not.toContain('mr_create_skip')
  })

  it('compiles into a valid LangGraph (no broken edges)', async () => {
    await bootstrapQuickImpl()
    const pipeline = await getTestPipelineByName(QUICK_IMPL_PIPELINE_NAME)
    expect(pipeline).toBeDefined()
    expect(pipeline!.graph).toBeDefined()

    const graph = pipeline!.graph as PipelineGraph

    // buildGraphFromPipeline 不抛错（验证 edges target 都存在、stageType 都注册）
    expect(() =>
      buildGraphFromPipeline({
        graph,
        stageContext: BASE_CTX as any,
        hooks: BASE_HOOKS,
        triggerParams: {},
      }),
    ).not.toThrow()
  })
})
