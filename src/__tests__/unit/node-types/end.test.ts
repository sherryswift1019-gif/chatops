import { describe, it, expect } from 'vitest'
import { getExecutor } from '../../../pipeline/node-types/registry.js'

// Static import triggers self-registration; matches the pattern in
// invoke-target-script.test.ts (avoid __resetRegistryForTesting + dynamic
// import — ESM module cache makes the second import a no-op).
import '../../../pipeline/node-types/end.js'

describe('end node type', () => {
  it('registers as "end" kind', () => {
    const exec = getExecutor('end')
    expect(exec).toBeDefined()
    expect(exec?.key).toBe('end')
  })

  it('executes as success no-op', async () => {
    const exec = getExecutor('end')
    const result = await exec!.execute({}, {
      runId: 1, pipelineId: 1, nodeId: 'done',
      triggerParams: {}, vars: {}, steps: {},
    })
    expect(result.status).toBe('success')
    expect(result.output).toEqual({ terminated: true })
  })
})
