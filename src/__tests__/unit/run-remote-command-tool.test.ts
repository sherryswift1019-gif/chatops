import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { TaskContext } from '../../agent/tools/types.js'

// Mock sshExec used by run-remote-command tool
const sshExecMock = vi.hoisted(() => vi.fn())
vi.mock('../../pipeline/ssh.js', () => ({ sshExec: sshExecMock }))

// Mock test-servers repo
const getTestServerByHostMock = vi.hoisted(() => vi.fn())
vi.mock('../../db/repositories/test-servers.js', () => ({
  getTestServerByHost: getTestServerByHostMock,
}))

import { runRemoteCommandTool } from '../../agent/tools/run-remote-command.js'

const baseCtx: TaskContext = {
  taskId: 't1', groupId: 'g1', platform: 'pipeline',
  initiatorId: 'u1', initiatorRole: 'admin',
}

const SECRET = 'SECRET_PWD_DO_NOT_LEAK'

function fakeServer(overrides: Record<string, unknown> = {}) {
  return {
    id: 1, productLineId: 1, name: 'srv-a', host: '10.0.0.5', port: 22,
    username: 'root', authType: 'password', credential: SECRET, role: 'app',
    status: 'idle', tags: {}, createdAt: new Date(), updatedAt: new Date(),
    ...overrides,
  }
}

describe('run_remote_command tool', () => {
  beforeEach(() => {
    sshExecMock.mockReset()
    getTestServerByHostMock.mockReset()
  })

  it('host not in test_servers: returns failure with "not registered"', async () => {
    getTestServerByHostMock.mockResolvedValueOnce(null)
    const r = await runRemoteCommandTool.execute(
      { host: '1.2.3.4', command: 'ls' },
      baseCtx,
    )
    expect(r.success).toBe(false)
    expect(r.output).toMatch(/not registered/i)
    expect(sshExecMock).not.toHaveBeenCalled()
  })

  it('timeoutMs out of range: clamps to default/upper bound when calling sshExec', async () => {
    getTestServerByHostMock.mockResolvedValue(fakeServer())
    sshExecMock.mockResolvedValue({ stdout: '', stderr: '', code: 0 })

    // 0 -> default 300000
    await runRemoteCommandTool.execute({ host: '10.0.0.5', command: 'x', timeoutMs: 0 }, baseCtx)
    expect(sshExecMock.mock.calls[0]?.[2]).toBe(300_000)

    // negative -> default 300000
    await runRemoteCommandTool.execute({ host: '10.0.0.5', command: 'x', timeoutMs: -100 }, baseCtx)
    expect(sshExecMock.mock.calls[1]?.[2]).toBe(300_000)

    // way too big -> clamped to 1_800_000
    await runRemoteCommandTool.execute({ host: '10.0.0.5', command: 'x', timeoutMs: 5_000_000 }, baseCtx)
    expect(sshExecMock.mock.calls[2]?.[2]).toBe(1_800_000)

    // missing -> default 300000
    await runRemoteCommandTool.execute({ host: '10.0.0.5', command: 'x' }, baseCtx)
    expect(sshExecMock.mock.calls[3]?.[2]).toBe(300_000)
  })

  it('command success (code=0): success=true, output contains stdout/stderr, exitCode=0', async () => {
    getTestServerByHostMock.mockResolvedValueOnce(fakeServer())
    sshExecMock.mockResolvedValueOnce({ stdout: 'hello world', stderr: 'warn: x', code: 0 })

    const r = await runRemoteCommandTool.execute(
      { host: '10.0.0.5', command: 'echo hi' },
      baseCtx,
    )
    expect(r.success).toBe(true)
    expect(r.output).toContain('exit 0')
    expect(r.output).toContain('hello world')
    expect(r.output).toContain('warn: x')
    expect((r.data as { exitCode: number }).exitCode).toBe(0)
  })

  it('command non-zero exit: success=false, exit code preserved, stdout/stderr returned', async () => {
    getTestServerByHostMock.mockResolvedValueOnce(fakeServer())
    sshExecMock.mockResolvedValueOnce({ stdout: 'partial', stderr: 'boom', code: 2 })

    const r = await runRemoteCommandTool.execute(
      { host: '10.0.0.5', command: 'false' },
      baseCtx,
    )
    expect(r.success).toBe(false)
    expect(r.output).toContain('exit 2')
    expect(r.output).toContain('boom')
    expect((r.data as { exitCode: number }).exitCode).toBe(2)
  })

  it('sshExec throws (timeout / connect refused): success=false, "SSH error" and no password leaks', async () => {
    getTestServerByHostMock.mockResolvedValueOnce(fakeServer())
    sshExecMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.0.0.5:22'))

    const r = await runRemoteCommandTool.execute(
      { host: '10.0.0.5', command: 'ls' },
      baseCtx,
    )
    expect(r.success).toBe(false)
    expect(r.output).toContain('SSH error')
    expect(r.output).not.toContain(SECRET)
    expect((r.data as { exitCode: number }).exitCode).toBe(-1)
  })

  it('credential never leaks into output across success / non-zero / throw paths', async () => {
    // success path
    getTestServerByHostMock.mockResolvedValueOnce(fakeServer())
    sshExecMock.mockResolvedValueOnce({ stdout: `echo ${SECRET}`, stderr: SECRET, code: 0 })
    const okRes = await runRemoteCommandTool.execute({ host: '10.0.0.5', command: 'x' }, baseCtx)
    // Note: stdout/stderr come from server output and *can* contain the literal secret if the
    // command echoed it — that's user-controlled, not a credential leak. The contract is the tool
    // must not append the server's stored credential itself. We prove that by using a server
    // whose stdout/stderr do NOT include the secret in the next two paths:

    getTestServerByHostMock.mockResolvedValueOnce(fakeServer())
    sshExecMock.mockResolvedValueOnce({ stdout: 'plain stdout', stderr: 'plain stderr', code: 0 })
    const r1 = await runRemoteCommandTool.execute({ host: '10.0.0.5', command: 'x' }, baseCtx)
    expect(r1.output).not.toContain(SECRET)

    getTestServerByHostMock.mockResolvedValueOnce(fakeServer())
    sshExecMock.mockResolvedValueOnce({ stdout: 'plain', stderr: 'plain', code: 7 })
    const r2 = await runRemoteCommandTool.execute({ host: '10.0.0.5', command: 'x' }, baseCtx)
    expect(r2.output).not.toContain(SECRET)

    getTestServerByHostMock.mockResolvedValueOnce(fakeServer())
    // simulate an SSH library error that (defensively) might include connection details — must
    // still not contain the credential
    sshExecMock.mockRejectedValueOnce(new Error('handshake failed'))
    const r3 = await runRemoteCommandTool.execute({ host: '10.0.0.5', command: 'x' }, baseCtx)
    expect(r3.output).not.toContain(SECRET)

    // and confirm okRes echo case (sanity — still no `password=` leak from tool itself)
    expect(okRes.output).not.toMatch(/password\s*[:=]/i)
  })
})
