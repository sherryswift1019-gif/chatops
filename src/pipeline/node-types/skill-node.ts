import { registerNodeType } from './registry.js'

/**
 * skill_node — 一次性产出（无循环），Phase 1 Quick-Impl。
 *
 * 同 approval.ts：实际执行路径是 graph-builder.ts:buildSkillNode，
 * 此处仅为 DB pipeline_node_types key 一致性注册。
 * 直接调用 NodeExecutor.execute() 会抛出（无 StageContextBase / SkillExecutor）。
 */
registerNodeType({
  key: 'skill_node',
  async execute() {
    throw new Error(
      'skill_node is context-bound: must be invoked via graph-builder switch (buildSkillNode). See src/pipeline/node-types/skill-node.ts.',
    )
  },
})
