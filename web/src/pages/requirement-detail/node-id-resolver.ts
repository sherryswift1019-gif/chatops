/**
 * 后端 stage_results.name 实际存的是节点 display name（如 "Spec Author"），
 * 而 effectiveStatus / qi-stage-map 等前端逻辑用稳定的节点 id（如 "spec_author"）
 * 作为 key。这里做一层 displayName → nodeId 的适配。
 *
 * 映射表与 src/quick-impl/bootstrap.ts 中 makeNode(id, { name }) 双源同步：
 * bootstrap.ts 改 display name 时需同步更新这里。
 */

export const STAGE_NAME_TO_NODE_ID: Record<string, string> = {
  'Init Branch': 'init_branch',
  'Spec Author': 'spec_author',
  'Spec AI Review': 'spec_ai_review',
  'Spec Human Gate': 'spec_human_gate',
  'Spec Commit & Push': 'spec_commit_push',
  'Plan Author': 'plan_author',
  'Plan AI Review': 'plan_ai_review',
  'Plan Human Gate': 'plan_human_gate',
  'Plan Commit & Push': 'plan_commit_push',
  'Dev Author': 'dev_author',
  'Dev AI Review': 'dev_ai_review',
  'Dev Human Gate': 'dev_human_gate',
  'Dev Push': 'dev_push',
  'E2E Skip Router': 'e2e_skip_router',
  'QI E2E Test': 'qi_e2e_runner',
  'E2E Router': 'e2e_router',
  'Dev Fix Author': 'dev_fix_author',
  'Dev Fix AI Review': 'dev_fix_ai_review',
  'E2E 人工介入': 'e2e_im_intervention',
  'IM 决策路由': 'e2e_intervention_router',
  'Sandbox 失败介入': 'e2e_sandbox_intervention',
  'Sandbox 决策路由': 'sandbox_intervention_router',
  'Final Approval': 'final_approval',
  'Create MR': 'mr_create',
  'Cleanup': 'cleanup',
  'Done': 'done',
}

/**
 * stage_results.name 是后端 display name；若已经是 node id（如老 stage_results 或单测 mock）
 * 直接 passthrough。返回 node id 供 effectiveStatus / qi-stage-map 查表。
 */
export function resolveNodeId(stageResultName: string): string {
  return STAGE_NAME_TO_NODE_ID[stageResultName] ?? stageResultName
}
