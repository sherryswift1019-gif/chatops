import { registerNodeType } from './registry.js'

/**
 * skill_with_review — 生成 + AI Reviewer + fail 修复循环，Phase 1 Quick-Impl。
 *
 * 实际执行路径：graph-builder.ts:buildSkillWithReviewNode（异步循环节点）。
 * 直接调用 NodeExecutor.execute() 会抛出——需 StageContextBase / SkillExecutor。
 */
registerNodeType({
  key: 'skill_with_review',
  async execute() {
    throw new Error(
      'skill_with_review is context-bound: must be invoked via graph-builder switch (buildSkillWithReviewNode). See src/pipeline/node-types/skill-with-review.ts.',
    )
  },
})
