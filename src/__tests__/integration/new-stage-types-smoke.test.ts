/**
 * Smoke test: 验证 6 个新 stage type（end / cleanup / git_commit_push /
 * llm_author / llm_review / human_gate）能在 graph-builder 里被识别、addNode，
 * 调 buildGraphFromPipeline 不抛错。
 *
 * 不执行 graph（避免 DB 调用 / LLM 调用 / interrupt 等副作用），
 * 只验证 builder 阶段本身 — stageType switch-case 命中而不走 default throw。
 */
import { describe, it, expect } from 'vitest'
import { buildGraphFromPipeline, type StageHooks } from '../../pipeline/graph-builder.js'
import type { PipelineGraph, PipelineNode } from '../../pipeline/types.js'

function makeNode(
  id: string,
  name: string,
  stageType: PipelineNode['stageType'],
  params: Record<string, unknown> = {},
): PipelineNode {
  return {
    id,
    name,
    stageType,
    params,
    targetRoles: [],
    parallel: false,
    timeoutSeconds: 60,
    retryCount: 0,
    onFailure: 'stop',
    position: { x: 0, y: 0 },
  } as PipelineNode
}

const BASE_HOOKS: StageHooks = {
  async runScript() {
    return { status: 'success', output: '' }
  },
}

const BASE_CTX = {
  runId: 9999,
  servers: {} as Record<string, never[]>,
  logDir: '/tmp/smoke-test',
  skillExecutor: {
    execute: async () => ({
      rawOutput: '{"decision":"pass","notes":"smoke ok"}',
    }),
  },
}

describe('new stage types smoke — buildGraphFromPipeline recognises all 6 new types', () => {
  it('builds a graph with all 6 new stage types without throwing', () => {
    // 构造覆盖全部 6 个新 stage type 的最小 pipeline
    const nodes: PipelineNode[] = [
      // 入口节点（已有类型，作为 graph 起点）
      makeNode('n0', 'start', 'script', { command: 'echo start' }),
      // 6 个新 stage type
      makeNode('n1', 'spec_author', 'llm_author', {
        requirementId: 1,
        skill: 'quick-impl',
        role: 'spec-author',
        worktreePath: '/tmp/wt',
        branch: 'qi/1',
        baseBranch: 'main',
        artifactPath: '/tmp/wt/spec.md',
      }),
      makeNode('n2', 'spec_ai_review', 'llm_review', {
        requirementId: 1,
        skill: 'quick-impl',
        role: 'spec-reviewer',
        worktreePath: '/tmp/wt',
        branch: 'qi/1',
        artifactPath: '/tmp/wt/spec.md',
      }),
      makeNode('n3', 'spec_human_gate', 'human_gate', {
        requirementId: 1,
        mode: 'always',
      }),
      makeNode('n4', 'spec_commit_push', 'git_commit_push', {
        worktreePath: '/tmp/wt',
        branch: 'qi/1',
        commitMessage: 'feat: add spec',
      }),
      makeNode('n5', 'cleanup_node', 'cleanup', {
        targets: [],
      }),
      makeNode('n6', 'done', 'end', {}),
    ]

    const edges: PipelineGraph['edges'] = [
      { id: 'e0', source: 'n0', target: 'n1' },
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
      { id: 'e4', source: 'n4', target: 'n5' },
      { id: 'e5', source: 'n5', target: 'n6' },
    ]

    const graph: PipelineGraph = { nodes, edges }

    // 只验证构建阶段不抛错，不编译也不执行
    expect(() =>
      buildGraphFromPipeline({
        graph,
        stageContext: BASE_CTX,
        hooks: BASE_HOOKS,
        triggerParams: {},
      }),
    ).not.toThrow()
  })

  it('builds each new stage type individually without throwing', () => {
    const newTypes: Array<{ stageType: PipelineNode['stageType']; params: Record<string, unknown> }> = [
      { stageType: 'end', params: {} },
      { stageType: 'cleanup', params: { targets: [] } },
      { stageType: 'git_commit_push', params: { worktreePath: '/tmp', branch: 'b', commitMessage: 'c' } },
      { stageType: 'llm_author', params: { requirementId: 1, skill: 's', role: 'r', worktreePath: '/tmp', branch: 'b', artifactPath: '/tmp/f.md' } },
      { stageType: 'llm_review', params: { requirementId: 1, skill: 's', role: 'r', worktreePath: '/tmp', branch: 'b', artifactPath: '/tmp/f.md' } },
      { stageType: 'human_gate', params: { requirementId: 1, mode: 'always' } },
    ]

    for (const { stageType, params } of newTypes) {
      const node = makeNode('nx', `test-${stageType}`, stageType, params)
      const graph: PipelineGraph = { nodes: [node], edges: [] }
      expect(
        () => buildGraphFromPipeline({ graph, stageContext: BASE_CTX, hooks: BASE_HOOKS }),
        `stageType "${stageType}" should not throw during graph build`,
      ).not.toThrow()
    }
  })
})
