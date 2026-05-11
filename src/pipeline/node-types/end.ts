import { registerNodeType } from './registry.js'
import type { NodeExecutionResult, ExecutionContext } from './types.js'

registerNodeType({
  key: 'end',
  async execute(
    _params: Record<string, unknown>,
    _ctx: ExecutionContext,
  ): Promise<NodeExecutionResult> {
    return { status: 'success', output: { terminated: true } }
  },
})
