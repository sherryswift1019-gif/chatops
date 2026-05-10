import { registerNodeType } from './registry.js'
import type { ExecutionContext, NodeExecutionResult } from './types.js'

/**
 * e2e_stub — Phase 1 always-pass stub。
 * Phase 2 替换为真实 e2e pipeline 调用。
 */
registerNodeType({
  key: 'e2e_stub',
  async execute(
    _params: Record<string, unknown>,
    _ctx: ExecutionContext,
  ): Promise<NodeExecutionResult> {
    return {
      status: 'success',
      output: { status: 'pass (stub)', e2eUrl: null, durationMs: 0 },
    }
  },
})
