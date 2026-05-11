import { describe, it, expect } from 'vitest'
import { getExecutor } from '../../../pipeline/node-types/registry.js'
import '../../../pipeline/node-types/llm-author.js'

describe('llm_author node type stub', () => {
  it('registers as "llm_author" kind', () => {
    expect(getExecutor('llm_author')?.key).toBe('llm_author')
  })

  it('stub throws on direct execute (must use graph-builder)', async () => {
    await expect(
      getExecutor('llm_author')!.execute({}, { runId: 1, pipelineId: 1, nodeId: 'x', triggerParams: {}, vars: {}, steps: {} }),
    ).rejects.toThrow(/graph-builder/)
  })
})
