import { registerNodeType } from './registry.js'

/**
 * llm_author — LLM 生成 artifact（不 commit），Pipeline Stage Types Sub-plan A Task 4。
 *
 * 实际执行路径：graph-builder.ts:buildLlmAuthorNode（访问 ctxBase.skillExecutor / mcpServerPath）。
 * 直接调用 NodeExecutor.execute() 会抛出——需 StageContextBase / SkillExecutor。
 */
registerNodeType({
  key: 'llm_author',
  async execute() {
    throw new Error(
      'llm_author must be invoked via graph-builder (buildLlmAuthorNode). See src/pipeline/graph-builder.ts.',
    )
  },
})
