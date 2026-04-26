import { describe, it, expect, vi, beforeEach, afterAll, beforeAll } from 'vitest'
import { writeFile, unlink, mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ExecutionContext } from '../../pipeline/node-types/types.js'

// Mock ssh.ts before importing the executor (which registers on import).
vi.mock('../../pipeline/ssh.js', () => ({
  sshExec: vi.fn(),
}))

import { sshExec } from '../../pipeline/ssh.js'
import '../../pipeline/node-types/file-read.js'
import { getExecutor } from '../../pipeline/node-types/registry.js'

const mockedSshExec = vi.mocked(sshExec)

let tmpDir: string

function makeCtx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    runId: 1,
    pipelineId: 100,
    nodeId: 'f1',
    triggerParams: {},
    vars: {},
    steps: {},
    ...overrides,
  }
}

function loadFileReadExecutor() {
  const exec = getExecutor('file_read')
  if (!exec) throw new Error('file_read executor not registered')
  return exec
}

describe('file_read node executor (phase 3 T13)', () => {
  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'file-read-test-'))
  })

  beforeEach(() => mockedSshExec.mockReset())

  describe('local target', () => {
    it('reads file content + size on happy path', async () => {
      const file = join(tmpDir, 'a.txt')
      await writeFile(file, 'hello world')
      const exec = loadFileReadExecutor()

      const result = await exec.execute({ path: file }, makeCtx())
      expect(result.status).toBe('success')
      expect((result.output as Record<string, unknown>).content).toBe('hello world')
      expect((result.output as Record<string, unknown>).size).toBe(11)
      expect((result.output as Record<string, unknown>).truncated).toBeUndefined()
    })

    it('truncates content when size > maxBytes and sets truncated=true', async () => {
      const file = join(tmpDir, 'big.txt')
      await writeFile(file, 'x'.repeat(2000))
      const exec = loadFileReadExecutor()

      const result = await exec.execute({ path: file, maxBytes: 100 }, makeCtx())
      expect(result.status).toBe('success')
      const content = (result.output as Record<string, unknown>).content as string
      expect(content.length).toBe(100)
      expect((result.output as Record<string, unknown>).size).toBe(2000)
      expect((result.output as Record<string, unknown>).truncated).toBe(true)
    })

    it('file not found → failed with file-not-found error', async () => {
      const exec = loadFileReadExecutor()
      const result = await exec.execute(
        { path: '/no/such/path/xxx.txt' },
        makeCtx(),
      )
      expect(result.status).toBe('failed')
      expect(result.error).toMatch(/file not found/)
    })

    it('empty path → failed', async () => {
      const exec = loadFileReadExecutor()
      const result = await exec.execute({}, makeCtx())
      expect(result.status).toBe('failed')
      expect(result.error).toMatch(/path/)
    })
  })

  describe('remote (ssh) target', () => {
    it('reads via sshExec cat when target!=local and ctx.server set', async () => {
      mockedSshExec.mockResolvedValueOnce({ stdout: 'remote content\n', stderr: '', code: 0 })
      const exec = loadFileReadExecutor()

      const result = await exec.execute(
        { target: 'web-1', path: '/etc/hostname' },
        makeCtx({ server: { host: '10.0.0.1', port: 22, username: 'root', password: 'pw' } }),
      )

      expect(result.status).toBe('success')
      expect((result.output as Record<string, unknown>).content).toBe('remote content\n')
      expect((result.output as Record<string, unknown>).size).toBe(15)
      expect(mockedSshExec).toHaveBeenCalledTimes(1)
      const [, cmd] = mockedSshExec.mock.calls[0]
      expect(cmd).toContain('cat')
      expect(cmd).toContain("'/etc/hostname'")
    })

    it('failed when ctx.server missing for remote target', async () => {
      const exec = loadFileReadExecutor()
      const result = await exec.execute(
        { target: 'web-1', path: '/etc/hostname' },
        makeCtx({ server: undefined }),
      )
      expect(result.status).toBe('failed')
      expect(result.error).toMatch(/ctx\.server/)
      expect(mockedSshExec).not.toHaveBeenCalled()
    })

    it('failed when remote password missing', async () => {
      const exec = loadFileReadExecutor()
      const result = await exec.execute(
        { target: 'web-1', path: '/x' },
        makeCtx({ server: { host: 'h', port: 22, username: 'u' } }),
      )
      expect(result.status).toBe('failed')
      expect(result.error).toMatch(/password/)
    })

    it('failed when sshExec returns non-zero exit (file-not-found path)', async () => {
      mockedSshExec.mockResolvedValueOnce({ stdout: '', stderr: 'cat: /no/such: No such file or directory', code: 1 })
      const exec = loadFileReadExecutor()
      const result = await exec.execute(
        { target: 'web-1', path: '/no/such' },
        makeCtx({ server: { host: 'h', port: 22, username: 'u', password: 'p' } }),
      )
      expect(result.status).toBe('failed')
      expect(result.error).toMatch(/file not found/)
    })

    it('failed when sshExec throws', async () => {
      mockedSshExec.mockRejectedValueOnce(new Error('connection refused'))
      const exec = loadFileReadExecutor()
      const result = await exec.execute(
        { target: 'web-1', path: '/x' },
        makeCtx({ server: { host: 'h', port: 22, username: 'u', password: 'p' } }),
      )
      expect(result.status).toBe('failed')
      expect(result.error).toBe('connection refused')
    })

    it('truncates remote content when > maxBytes', async () => {
      mockedSshExec.mockResolvedValueOnce({ stdout: 'y'.repeat(500), stderr: '', code: 0 })
      const exec = loadFileReadExecutor()
      const result = await exec.execute(
        { target: 'web-1', path: '/x', maxBytes: 50 },
        makeCtx({ server: { host: 'h', port: 22, username: 'u', password: 'p' } }),
      )
      expect(result.status).toBe('success')
      const out = result.output as Record<string, unknown>
      expect((out.content as string).length).toBe(50)
      expect(out.size).toBe(500)
      expect(out.truncated).toBe(true)
    })
  })

  afterAll(async () => {
    // best-effort cleanup
    try { await unlink(join(tmpDir, 'a.txt')) } catch { /* ignore */ }
    try { await unlink(join(tmpDir, 'big.txt')) } catch { /* ignore */ }
  })
})
