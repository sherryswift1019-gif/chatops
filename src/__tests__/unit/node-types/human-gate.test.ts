import { describe, it, expect } from 'vitest'
import { getExecutor } from '../../../pipeline/node-types/registry.js'
import '../../../pipeline/node-types/human-gate.js'

describe('human_gate node type stub', () => {
  it('registers as "human_gate" kind', () => {
    expect(getExecutor('human_gate')?.key).toBe('human_gate')
  })

  it('stub throws on direct execute (must use graph-builder)', async () => {
    await expect(
      getExecutor('human_gate')!.execute({}, { runId: 1, pipelineId: 1, nodeId: 'x', triggerParams: {}, vars: {}, steps: {} }),
    ).rejects.toThrow(/graph-builder/)
  })
})
