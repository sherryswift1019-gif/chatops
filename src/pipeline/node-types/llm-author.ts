import { registerNodeType } from './registry.js'

registerNodeType({
  key: 'llm_author',
  async execute() {
    throw new Error(
      'llm_author must be invoked via graph-builder (buildLlmAuthorNode). See src/pipeline/graph-builder.ts.',
    )
  },
})
