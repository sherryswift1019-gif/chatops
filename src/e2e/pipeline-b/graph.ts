// src/e2e/pipeline-b/graph.ts
import { StateGraph, START, END } from '@langchain/langgraph'
import { PipelineBState, type PipelineBStateType } from './types.js'
import { governorCheck } from './governor.js'
import { initRunNode } from './nodes/init-run.js'
import { setupSandboxNode } from './nodes/setup-sandbox.js'
import { deployInitialNode } from './nodes/deploy-initial.js'
import { discoverNode } from './nodes/discover.js'
import { pickNextScenarioNode } from './nodes/pick-next-scenario.js'
import { runScenarioNode } from './nodes/run-scenario.js'
import { awaitHumanReviewNode } from './nodes/await-human-review.js'
import { resetIterationBranchNode } from './nodes/reset-iteration-branch.js'
import { e2eFixAgentNode } from './nodes/e2e-fix-agent.js'
import { redeployNode } from './nodes/redeploy.js'
import { healthcheckNode } from './nodes/healthcheck.js'
import { markGreenNode } from './nodes/mark-green.js'
import { markUnfixableNode } from './nodes/mark-unfixable.js'
import { createSummaryMrNode } from './nodes/create-summary-mr.js'
import { finalizeFailedNode } from './nodes/finalize-failed.js'
import { teardownSandboxNode } from './nodes/teardown-sandbox.js'

function mainSwitchRoute(state: PipelineBStateType): string {
  if (state.pendingScenarios.length === 0) return 'all_passed'
  if (governorCheck(state.governorState) === 'over_budget') return 'over_budget'
  return 'continue'
}

function scenarioResultRoute(state: PipelineBStateType): string {
  return state.lastScenarioResult === 'pass' ? 'pass' : 'fail'
}

function humanReviewRoute(state: PipelineBStateType): string {
  return state.humanReviewDecision ?? 'reject'
}

function fixResultRoute(state: PipelineBStateType): string {
  return state.lastFixResult?.success === true ? 'success' : 'failure'
}

export function buildPipelineBGraph() {
  const g = new StateGraph(PipelineBState)
    .addNode('init_run', initRunNode)
    .addNode('setup_sandbox', setupSandboxNode)
    .addNode('deploy_initial', deployInitialNode)
    .addNode('discover', discoverNode)
    .addNode('main_switch', async (state: PipelineBStateType) => state)
    .addNode('pick_next_scenario', pickNextScenarioNode)
    .addNode('run_scenario', runScenarioNode)
    .addNode('await_human_review', awaitHumanReviewNode)
    .addNode('reset_iteration_branch', resetIterationBranchNode)
    .addNode('e2e_fix_agent', async (state: PipelineBStateType) =>
      e2eFixAgentNode({
        sandboxHandle: state.sandboxHandle!,
        iterationBranch: state.iterationBranch,
        evidenceDir: state.evidenceDirTemp!,
        scenarioId: state.currentScenario!.id,
        scenarioRunId: state.currentScenarioRunId!,
        imContext: state.imContext ?? undefined,
      })
    )
    .addNode('redeploy', redeployNode)
    .addNode('healthcheck', healthcheckNode)
    .addNode('mark_green', markGreenNode)
    .addNode('mark_unfixable', markUnfixableNode)
    .addNode('create_summary_mr', createSummaryMrNode)
    .addNode('finalize_failed', finalizeFailedNode)
    .addNode('teardown_sandbox', teardownSandboxNode)

  g.addEdge(START, 'init_run')
  g.addEdge('init_run', 'setup_sandbox')
  g.addEdge('setup_sandbox', 'deploy_initial')
  g.addEdge('deploy_initial', 'discover')
  g.addEdge('discover', 'main_switch')

  g.addConditionalEdges('main_switch', mainSwitchRoute, {
    all_passed: 'create_summary_mr',
    over_budget: 'finalize_failed',
    continue: 'pick_next_scenario',
  })

  g.addEdge('pick_next_scenario', 'run_scenario')

  g.addConditionalEdges('run_scenario', scenarioResultRoute, {
    pass: 'mark_green',
    fail: 'await_human_review',
  })

  g.addEdge('mark_green', 'main_switch')

  // 人审 gate：approve→进 fix；retry→不修、把 scenario 丢回 pick_next；reject→标 unfixable
  g.addConditionalEdges('await_human_review', humanReviewRoute, {
    approve: 'reset_iteration_branch',
    retry: 'pick_next_scenario',
    reject: 'mark_unfixable',
  })

  g.addEdge('reset_iteration_branch', 'e2e_fix_agent')

  g.addConditionalEdges('e2e_fix_agent', fixResultRoute, {
    success: 'redeploy',
    failure: 'mark_unfixable',
  })

  g.addEdge('redeploy', 'healthcheck')
  g.addEdge('healthcheck', 'run_scenario')

  g.addEdge('mark_unfixable', 'main_switch')

  g.addEdge('create_summary_mr', 'teardown_sandbox')
  g.addEdge('finalize_failed', 'teardown_sandbox')
  g.addEdge('teardown_sandbox', END)

  return g.compile()
}
