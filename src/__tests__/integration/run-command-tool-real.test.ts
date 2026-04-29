import { describe, it, expect } from 'vitest'
import { execSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DockerExecutor } from '../../pipeline/executors/docker.js'
import { runCommandTool } from '../../agent/tools/run-command.js'
import type { TaskContext } from '../../agent/tools/types.js'

const hasDocker = (() => {
  try { execSync('docker version --format ok', { stdio: 'pipe' }); return true } catch { return false }
})()

describe.skipIf(!hasDocker)('run_command real docker', () => {
  it('docker path: command runs inside container with cwd from bind-mounted host dir', async () => {
    const hostDir = mkdtempSync(join(tmpdir(), 'chatops-rc-'))
    process.env.TEST_DATA_DIR = '/data/chatops/test-runs'
    writeFileSync(join(hostDir, 'marker.txt'), 'mounted')

    const name = `chatops-test-rc-${Date.now()}`
    const executor = new DockerExecutor('alpine:3.19')
    try {
      await executor.setup(name, { dataDirMount: { hostPath: hostDir } })
      const ctx: TaskContext = {
        taskId: 't', groupId: 'g', platform: 'pipeline',
        initiatorId: 'u', initiatorRole: 'admin',
        cwd: '/data/chatops/test-runs',
        dockerContainerName: name,
      }
      const r = await runCommandTool.execute({ command: 'cat marker.txt' }, ctx)
      expect(r.success).toBe(true)
      expect(r.output).toContain('mounted')
    } finally {
      await executor.teardown()
      rmSync(hostDir, { recursive: true, force: true })
    }
  }, 60_000)
})
