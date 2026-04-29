import { describe, it, expect } from 'vitest'
import { execSync } from 'child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DockerExecutor } from '../../pipeline/executors/docker.js'

const hasDocker = (() => {
  try { execSync('docker version --format ok', { stdio: 'pipe' }); return true } catch { return false }
})()

describe.skipIf(!hasDocker)('DockerExecutor real docker', () => {
  it('setup with dataDirMount: file written on host is visible inside container', async () => {
    const hostDir = mkdtempSync(join(tmpdir(), 'chatops-dood-'))
    process.env.TEST_DATA_DIR = '/data/chatops/test-runs'
    writeFileSync(join(hostDir, 'hello.txt'), 'from-host')

    const containerName = `chatops-test-dood-${Date.now()}`
    const executor = new DockerExecutor('alpine:3.19')
    try {
      await executor.setup(containerName, { dataDirMount: { hostPath: hostDir } })
      const result = await executor.exec('cat /data/chatops/test-runs/hello.txt')
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim()).toBe('from-host')
    } finally {
      await executor.teardown()
      rmSync(hostDir, { recursive: true, force: true })
    }
  }, 60_000)

  it('teardown removes the container', async () => {
    const containerName = `chatops-test-dood-tear-${Date.now()}`
    const executor = new DockerExecutor('alpine:3.19')
    await executor.setup(containerName)
    await executor.teardown()
    const out = execSync(`docker ps -a --filter name=^/${containerName}$ --format '{{.Names}}'`, { stdio: 'pipe' }).toString().trim()
    expect(out).toBe('')
  }, 60_000)
})
