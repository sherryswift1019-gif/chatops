import { registerNodeType } from './registry.js'

registerNodeType({
  key: 'llm_review',
  async execute() {
    throw new Error(
      'llm_review must be invoked via graph-builder (buildLlmReviewNode). See src/pipeline/graph-builder.ts.',
    )
  },
})
