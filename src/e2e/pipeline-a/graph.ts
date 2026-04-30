// src/e2e/pipeline-a/graph.ts
import { StateGraph, START, END } from '@langchain/langgraph'
import { PipelineAState } from './types.js'
import { initGenerationNode } from './nodes/init-generation.js'
import { generateOrSkipNode } from './nodes/generate-or-skip.js'
import { staticCheckNode } from './nodes/static-check.js'
import { setupBaselineSandboxNode, teardownBaselineSandboxNode } from './nodes/baseline-sandbox.js'
import { runBaselineCheckNode } from './nodes/baseline-check.js'
import { diagnoseBaselineNode, fixScriptNode } from './nodes/diagnose.js'
import { commitAndPrNode } from './nodes/commit-pr.js'
import type { PipelineAStateType } from './types.js'

export function buildPipelineAGraph() {
  const g = new StateGraph(PipelineAState)
    .addNode('init_generation', initGenerationNode)
    .addNode('generate_or_skip', generateOrSkipNode)
    .addNode('static_check', staticCheckNode)
    .addNode('fix_script_static', fixScriptNode)
    .addNode('setup_baseline_sandbox', setupBaselineSandboxNode)
    .addNode('run_baseline_check', runBaselineCheckNode)
    .addNode('diagnose_baseline', diagnoseBaselineNode)
    .addNode('fix_script_baseline', fixScriptNode)
    .addNode('commit_and_pr', commitAndPrNode)
    .addNode('teardown_sandbox', teardownBaselineSandboxNode)

  g.addEdge(START, 'init_generation')
  g.addEdge('init_generation', 'generate_or_skip')
  g.addEdge('generate_or_skip', 'static_check')

  g.addConditionalEdges('static_check', (s: PipelineAStateType) => {
    if (s.staticCheckResult === 'pass') return 'setup_baseline_sandbox'
    if (s.staticCheckAttempts >= s.maxStaticCheckAttempts) return 'teardown_sandbox'
    return 'fix_script_static'
  }, {
    setup_baseline_sandbox: 'setup_baseline_sandbox',
    fix_script_static: 'fix_script_static',
    teardown_sandbox: 'teardown_sandbox',
  })

  g.addEdge('fix_script_static', 'static_check')
  g.addEdge('setup_baseline_sandbox', 'run_baseline_check')

  g.addConditionalEdges('run_baseline_check', (s: PipelineAStateType) => {
    if (s.lastBaselineResult?.passed) return 'commit_and_pr'
    return 'diagnose_baseline'
  }, {
    commit_and_pr: 'commit_and_pr',
    diagnose_baseline: 'diagnose_baseline',
  })

  g.addConditionalEdges('diagnose_baseline', (s: PipelineAStateType) => {
    if (s.diagnosisVerdict === 'product_bug') return 'teardown_sandbox'
    if (s.baselineAttempts >= s.maxBaselineAttempts) return 'teardown_sandbox'
    return 'fix_script_baseline'
  }, {
    fix_script_baseline: 'fix_script_baseline',
    teardown_sandbox: 'teardown_sandbox',
  })

  g.addEdge('fix_script_baseline', 'run_baseline_check')
  g.addEdge('commit_and_pr', 'teardown_sandbox')

  g.addConditionalEdges('teardown_sandbox', (s: PipelineAStateType) => {
    if (s.currentSpecIndex < s.specs.length) return 'generate_or_skip'
    return END
  }, {
    generate_or_skip: 'generate_or_skip',
    [END]: END,
  })

  return g.compile()
}
