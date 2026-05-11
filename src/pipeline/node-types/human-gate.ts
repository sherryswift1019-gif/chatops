import { registerNodeType } from './registry.js'

registerNodeType({
  key: 'human_gate',
  async execute() {
    throw new Error(
      'human_gate is interrupt-bound: must be invoked via graph-builder (buildHumanGateNode). See src/pipeline/graph-builder.ts.',
    )
  },
})
