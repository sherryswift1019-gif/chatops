import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'

vi.mock('child_process', () => {
  return {
    spawn: vi.fn(),
  }
})

import { spawn } from 'child_process'
import { DockerExecutor } from '../../pipeline/executors/docker.js'

function mockSpawn(exitCode = 0, stdout = '', stderr = '') {
  const proc = new EventEmitter() as ReturnType<typeof spawn>
  ;(proc as unknown as { stdout: EventEmitter; stderr: EventEmitter }).stdout = new EventEmitter()
  ;(proc as unknown as { stdout: EventEmitter; stderr: EventEmitter }).stderr = new EventEmitter()
  setImmediate(() => {
    (proc as unknown as { stdout: EventEmitter }).stdout.emit('data', Buffer.from(stdout))
    ;(proc as unknown as { stderr: EventEmitter }).stderr.emit('data', Buffer.from(stderr))
    proc.emit('close', exitCode)
  })
  return proc
}

describe('DockerExecutor', () => {
  let callArgs: string[][]

  beforeEach(() => {
    callArgs = []
    vi.mocked(spawn).mockImplementation((_cmd, args) => {
      callArgs.push(args as string[])
      return mockSpawn(0)
    })
  })

  it('setup: calls docker pull then docker run -d', async () => {
    const executor = new DockerExecutor('node:18')
    await executor.setup('chatops-run-42')
    expect(callArgs[0]).toEqual(['pull', 'node:18'])
    expect(callArgs[1]).toContain('run')
    expect(callArgs[1]).toContain('chatops-run-42')
    expect(callArgs[1]).toContain('sleep')
  })

  it('exec: calls docker exec with sh -c', async () => {
    const executor = new DockerExecutor('node:18')
    await executor.setup('chatops-run-42')
    await executor.exec('echo hello')
    const execArgs = callArgs.find(a => a[0] === 'exec')!
    expect(execArgs).toContain('chatops-run-42')
    expect(execArgs).toContain('echo hello')
  })

  it('teardown: calls docker rm -f', async () => {
    const executor = new DockerExecutor('node:18')
    await executor.setup('chatops-run-42')
    await executor.teardown()
    const rmArgs = callArgs.find(a => a[0] === 'rm')!
    expect(rmArgs).toContain('-f')
    expect(rmArgs).toContain('chatops-run-42')
  })

  it('setup fails if docker pull returns non-zero', async () => {
    vi.mocked(spawn).mockImplementationOnce(() => mockSpawn(1, '', 'image not found'))
    const executor = new DockerExecutor('nonexistent:image')
    await expect(executor.setup('chatops-run-1')).rejects.toThrow('Failed to pull image')
  })

  it('exec throws if setup not called', async () => {
    const executor = new DockerExecutor('node:18')
    await expect(executor.exec('ls')).rejects.toThrow('setup() has not been called')
  })
})
