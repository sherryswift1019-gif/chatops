import { registerNodeType } from './registry.js'

/**
 * skill_with_approval — 生成 + 双端审批 + reject 回生循环，Phase 1 Quick-Impl。
 *
 * 实际执行路径：graph-builder.ts:buildSkillWithApprovalNode（interrupt-bound 节点）。
 * 直接调用 NodeExecutor.execute() 会抛出——interrupt() 需 LangGraph supergraph 接住。
 */
registerNodeType({
  key: 'skill_with_approval',
  async execute() {
    throw new Error(
      'skill_with_approval is interrupt-bound: must be invoked via graph-builder switch (buildSkillWithApprovalNode). See src/pipeline/node-types/skill-with-approval.ts.',
    )
  },
})
