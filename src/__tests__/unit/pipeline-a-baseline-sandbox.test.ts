// src/__tests__/unit/pipeline-a-baseline-sandbox.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('child_process', () => ({ spawnSync: vi.fn(), execSync: vi.fn() }))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(false),
    mkdirSync: vi.fn(),
  }
})
vi.mock('../../db/repositories/e2e-sandboxes.js', () => ({
  createSandbox: vi.fn().mockResolvedValue({ id: 1n, status: 'provisioning', handle: {} }),
  updateSandboxStatus: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../db/repositories/e2e-target-projects.js', () => ({
  getE2eTargetProject: vi.fn().mockResolvedValue({
    id: 'chatops',
    gitlabRepo: 'http://code.paraview.cn/foo/chatops.git',
    defaultBranch: 'main',
    scripts: { deploy: 'deploy.sh', build: 'build.sh', test: 'test.sh' },
    workingDir: '.',
  }),
  extractGitlabPath: vi.fn().mockReturnValue('foo/chatops'),
}))
vi.mock('../../config/gitlab.js', () => ({
  resolveGitlabConfig: vi.fn().mockResolvedValue({ url: 'http://code.paraview.cn', token: 'test-token' }),
}))

import { spawnSync, execSync } from 'child_process'
import { readFileSync } from 'fs'
import { setupBaselineSandboxNode } from '../../e2e/pipeline-a/nodes/baseline-sandbox.js'

const TEST_DATA_DIR = '/data/chatops/test-runs'
const HOST_TEST_DATA_DIR = '/srv/chatops/test-runs'

const baseState = {
  specs: [{ specId: 1n, targetProjectId: 'chatops', specPath: 's.md', title: 'S', contentHash: 'x' }],
  currentSpecIndex: 0, baseBranch: 'main', targetProjectId: 'chatops',
  specPaths: [], sandboxHandle: null, baselineAttempts: 0, lastBaselineResult: null,
  completedSpecs: [], maxBaselineAttempts: 3, maxStaticCheckAttempts: 2,
  staticCheckAttempts: 0, lastError: null, staticCheckResult: null, diagnosisVerdict: null,
}

const HANDLE_JSON = '{"envId":"test-1","kind":"docker-compose-local","endpoints":{"api":"http://localhost:13001"},"internalRefs":{}}'

describe('setupBaselineSandboxNode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.TEST_DATA_DIR = TEST_DATA_DIR
    process.env.HOST_TEST_DATA_DIR = HOST_TEST_DATA_DIR
  })

  it('provision 通过 docker run（DooD）调用脚本，而非直接 spawnSync 脚本路径', async () => {
    vi.mocked(readFileSync).mockReturnValue(HANDLE_JSON as any)
    vi.mocked(spawnSync)
      .mockReturnValue({ status: 0, stdout: '', stderr: '' } as any)

    await setupBaselineSandboxNode(baseState as any)

    // 关键断言：第一个参数必须是 'docker'，而不是裸脚本路径
    const firstCallCmd = vi.mocked(spawnSync).mock.calls[0][0]
    expect(firstCallCmd).toBe('docker')

    // 断言包含 docker run + DooD 必要参数
    const firstCallArgs = vi.mocked(spawnSync).mock.calls[0][1] as string[]
    expect(firstCallArgs).toContain('run')
    expect(firstCallArgs).toContain('--rm')
    expect(firstCallArgs.join(' ')).toContain('/var/run/docker.sock:/var/run/docker.sock')

    // 断言 workspace 挂载使用了宿主机路径（HOST_TEST_DATA_DIR）
    const hostWorkspace = `${HOST_TEST_DATA_DIR}/workspaces/chatops`
    expect(firstCallArgs.join(' ')).toContain(hostWorkspace)
  })

  it('provision 成功 → sandboxHandle 非空', async () => {
    vi.mocked(readFileSync).mockReturnValue(HANDLE_JSON as any)
    vi.mocked(spawnSync)
      .mockReturnValue({ status: 0, stdout: '', stderr: '' } as any)

    const result = await setupBaselineSandboxNode(baseState as any)
    expect(result.sandboxHandle).not.toBeNull()
    expect(result.sandboxHandle?.envId).toBe('test-1')
  })

  it('provision 失败 → throws', async () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 1, stdout: '', stderr: 'docker error' } as any)
    await expect(setupBaselineSandboxNode(baseState as any)).rejects.toThrow('provision failed')
  })

  it('git clone 在 workspace 不存在时被调用', async () => {
    vi.mocked(readFileSync).mockReturnValue(HANDLE_JSON as any)
    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: '', stderr: '' } as any)

    await setupBaselineSandboxNode(baseState as any)

    expect(vi.mocked(execSync)).toHaveBeenCalled()
    const cloneCall = vi.mocked(execSync).mock.calls[0][0] as string
    expect(cloneCall).toContain('git clone')
    expect(cloneCall).toContain('oauth2:test-token')
  })
})
