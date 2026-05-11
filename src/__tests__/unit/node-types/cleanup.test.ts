import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { getExecutor } from '../../../pipeline/node-types/registry.js'
import '../../../pipeline/node-types/cleanup.js'

describe('cleanup node type', () => {
  it('removes worktree directory if exists', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cleanup-test-'))
    await fs.writeFile(path.join(tmpDir, 'a.txt'), 'hello')

    const exec = getExecutor('cleanup')
    const result = await exec!.execute(
      { targets: [{ kind: 'worktree', path: tmpDir }] },
      { runId: 1, pipelineId: 1, nodeId: 'cleanup', triggerParams: {}, vars: {}, steps: {} },
    )

    expect(result.status).toBe('success')
    expect(result.output.report).toMatchObject({
      cleaned: [{ kind: 'worktree', path: tmpDir, ok: true }],
      failed: [],
    })

    await expect(fs.access(tmpDir)).rejects.toThrow()
  })

  it('reports failed targets but still returns success status (warn-continue)', async () => {
    const exec = getExecutor('cleanup')
    const result = await exec!.execute(
      { targets: [{ kind: 'remote_branch', project: 'foo/bar', branch: 'feat/x' }] },
      { runId: 1, pipelineId: 1, nodeId: 'cleanup', triggerParams: {}, vars: {}, steps: {} },
    )

    expect(result.status).toBe('success')
    expect(result.output.report).toMatchObject({
      cleaned: [],
      failed: [{ kind: 'remote_branch', ok: false }],
    })
  })

  it('handles empty targets gracefully', async () => {
    const exec = getExecutor('cleanup')
    const result = await exec!.execute(
      { targets: [] },
      { runId: 1, pipelineId: 1, nodeId: 'cleanup', triggerParams: {}, vars: {}, steps: {} },
    )
    expect(result.status).toBe('success')
    expect(result.output.report).toMatchObject({ cleaned: [], failed: [] })
  })
})
