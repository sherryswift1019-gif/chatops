import { describe, it, expect } from 'vitest'
import { getExecutor } from '../../../pipeline/node-types/registry.js'
import '../../../pipeline/node-types/llm-review.js'

describe('llm_review node type stub', () => {
  it('registers as "llm_review" kind', () => {
    expect(getExecutor('llm_review')?.key).toBe('llm_review')
  })

  it('stub throws on direct execute (must use graph-builder)', async () => {
    await expect(
      getExecutor('llm_review')!.execute({}, { runId: 1, pipelineId: 1, nodeId: 'x', triggerParams: {}, vars: {}, steps: {} }),
    ).rejects.toThrow(/graph-builder/)
  })
})
