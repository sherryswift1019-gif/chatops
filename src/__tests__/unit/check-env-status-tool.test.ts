import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../db/repositories/tool-permissions.js', () => ({
  getToolPermissions: vi.fn().mockResolvedValue([]),
}))
vi.mock('../../db/repositories/projects-repo.js', () => ({ listProjects: vi.fn() }))
vi.mock('../../db/repositories/product-lines.js', () => ({ getProductLineById: vi.fn() }))
vi.mock('../../db/repositories/environments-repo.js', () => ({ listEnvironments: vi.fn() }))
vi.mock('../../db/repositories/product-line-envs.js', () => ({ listProductLineEnvs: vi.fn() }))
vi.mock('../../db/repositories/deployments.js', () => ({ getRecentDeployments: vi.fn() }))
vi.mock('../../db/repositories/system-config.js', () => ({ getConfig: vi.fn() }))
vi.mock('../../db/repositories/test-servers.js', () => ({ getTestServerById: vi.fn() }))
vi.mock('../../agent/tools/env-status/docker-probe.js', () => ({ probeContainer: vi.fn() }))
vi.mock('../../agent/tools/env-status/k8s-probe.js', () => ({ probeK8sDeployment: vi.fn() }))
vi.mock('../../agent/tools/env-status/gitlab.js', () => ({
  getLatestBranchCommit: vi.fn(),
  compareCommits: vi.fn(),
}))

import { listProjects } from '../../db/repositories/projects-repo.js'
import { getProductLineById } from '../../db/repositories/product-lines.js'
import { listEnvironments } from '../../db/repositories/environments-repo.js'
import { listProductLineEnvs } from '../../db/repositories/product-line-envs.js'
import { getRecentDeployments } from '../../db/repositories/deployments.js'
import { getConfig } from '../../db/repositories/system-config.js'
import { getTestServerById } from '../../db/repositories/test-servers.js'
import { probeContainer } from '../../agent/tools/env-status/docker-probe.js'
import { probeK8sDeployment } from '../../agent/tools/env-status/k8s-probe.js'
import { getLatestBranchCommit, compareCommits } from '../../agent/tools/env-status/gitlab.js'
import { checkEnvStatusTool } from '../../agent/tools/check-env-status.js'
import type { TaskContext } from '../../agent/tools/types.js'

const ctx: TaskContext = {
  taskId: 't', groupId: 'g', platform: 'dingtalk',
  initiatorId: 'u1', initiatorRole: 'ops', productLineId: 1,
}

beforeEach(() => { vi.clearAllMocks() })

describe('check_environment_status tool', () => {
  it('rejects when user not bound to product line', async () => {
    const r = await checkEnvStatusTool.execute({ env: 'dev' }, { ...ctx, productLineId: undefined })
    expect(r.success).toBe(false)
    expect(r.output).toContain('未加入任何产线')
  })

  it('rejects unknown env', async () => {
    vi.mocked(listEnvironments).mockResolvedValue([{ id: 1, name: 'dev', displayName: 'Dev', sortOrder: 0, createdAt: new Date() }])
    const r = await checkEnvStatusTool.execute({ env: 'nonexistent' }, ctx)
    expect(r.success).toBe(false)
    expect(r.output).toContain('未定义')
  })

  it('rejects when env not configured for product line', async () => {
    vi.mocked(listEnvironments).mockResolvedValue([{ id: 1, name: 'dev', displayName: 'Dev', sortOrder: 0, createdAt: new Date() }])
    vi.mocked(listProductLineEnvs).mockResolvedValue([])
    vi.mocked(getProductLineById).mockResolvedValue({ id: 1, name: 'pl', displayName: 'PL', description: '', createdAt: new Date(), updatedAt: new Date() })
    const r = await checkEnvStatusTool.execute({ env: 'dev' }, ctx)
    expect(r.success).toBe(false)
    expect(r.output).toContain('未配置')
  })

  it('scans all projects and returns formatted output', async () => {
    vi.mocked(listEnvironments).mockResolvedValue([{ id: 1, name: 'dev', displayName: 'Dev', sortOrder: 0, createdAt: new Date() }])
    vi.mocked(getProductLineById).mockResolvedValue({ id: 1, name: 'pl', displayName: 'PL', description: '', createdAt: new Date(), updatedAt: new Date() })
    vi.mocked(listProductLineEnvs).mockResolvedValue([{
      id: 1, productLineId: 1, envId: 1, runtime: 'docker', namespace: '', enabled: true,
      connectionConfig: { serverIds: [10] }, defaultBranch: 'develop',
    }])
    vi.mocked(getTestServerById).mockResolvedValue({
      id: 10, productLineId: 1, name: 's1', role: 'app',
      host: '10.0.0.5', port: 22, username: 'root', credential: 'x',
      createdAt: new Date(),
    } as unknown as Awaited<ReturnType<typeof getTestServerById>>)
    vi.mocked(listProjects).mockResolvedValue([{
      id: 100, productLineId: 1, name: 'svc', displayName: 'SVC',
      gitlabPath: 'g/svc', harborProject: 'p/svc',
      ownerId: '', ownerName: '',
      dockerContainerName: 'svc', k8sProjectName: '', composePath: '/opt/app',
      description: '', createdAt: new Date(), updatedAt: new Date(),
    }])
    vi.mocked(getConfig).mockResolvedValue({ key: 'harbor', value: { url: 'https://harbor.example.com' }, updatedAt: new Date() } as unknown as Awaited<ReturnType<typeof getConfig>>)
    vi.mocked(getRecentDeployments).mockResolvedValue([])
    vi.mocked(probeContainer).mockResolvedValue({
      container: { exists: true, state: 'running', startedAt: new Date().toISOString(), health: 'healthy' },
      deployed: { branch: 'develop', shortId: 'a1b2c3d4', imageTag: 'develop_a1b2c3d4' },
    })
    vi.mocked(getLatestBranchCommit).mockResolvedValue({ commitId: 'full', shortId: 'a1b2c3d4', message: 'fix' })
    vi.mocked(compareCommits).mockResolvedValue({ commitsBehind: 0, tooLarge: false, latestSummaries: [] })

    const r = await checkEnvStatusTool.execute({ env: 'dev' }, ctx)
    expect(r.success).toBe(true)
    expect(r.output).toContain('SVC')
    expect(r.output).toContain('✅')
    expect(r.output).toContain('develop_a1b2c3d4')
    expect(probeContainer).toHaveBeenCalledWith(
      expect.objectContaining({ host: '10.0.0.5' }),
      '/opt/app/docker-compose.yml',
      'svc',
      'harbor.example.com',
      'p/svc',
    )
  })

  it('filters to single project when project param given', async () => {
    vi.mocked(listEnvironments).mockResolvedValue([{ id: 1, name: 'dev', displayName: 'Dev', sortOrder: 0, createdAt: new Date() }])
    vi.mocked(getProductLineById).mockResolvedValue({ id: 1, name: 'pl', displayName: 'PL', description: '', createdAt: new Date(), updatedAt: new Date() })
    vi.mocked(listProductLineEnvs).mockResolvedValue([{
      id: 1, productLineId: 1, envId: 1, runtime: 'docker', namespace: '', enabled: true,
      connectionConfig: { serverIds: [10] }, defaultBranch: 'develop',
    }])
    vi.mocked(getTestServerById).mockResolvedValue({
      id: 10, productLineId: 1, name: 's1', role: 'app',
      host: '10.0.0.5', port: 22, username: 'root', credential: 'x',
      createdAt: new Date(),
    } as unknown as Awaited<ReturnType<typeof getTestServerById>>)
    vi.mocked(listProjects).mockResolvedValue([
      { id: 100, productLineId: 1, name: 'a', displayName: 'A', gitlabPath: 'g/a', harborProject: 'p/a', ownerId:'', ownerName:'', dockerContainerName: 'a', k8sProjectName:'', composePath:'/opt/a', description:'', createdAt: new Date(), updatedAt: new Date() },
      { id: 101, productLineId: 1, name: 'b', displayName: 'B', gitlabPath: 'g/b', harborProject: 'p/b', ownerId:'', ownerName:'', dockerContainerName: 'b', k8sProjectName:'', composePath:'/opt/b', description:'', createdAt: new Date(), updatedAt: new Date() },
    ])
    vi.mocked(getConfig).mockResolvedValue({ key: 'harbor', value: { url: 'https://harbor.example.com' }, updatedAt: new Date() } as unknown as Awaited<ReturnType<typeof getConfig>>)
    vi.mocked(getRecentDeployments).mockResolvedValue([])
    vi.mocked(probeContainer).mockResolvedValue({ container: { exists: false }, deployed: null })
    vi.mocked(getLatestBranchCommit).mockResolvedValue(null)
    vi.mocked(compareCommits).mockResolvedValue(null)

    const r = await checkEnvStatusTool.execute({ env: 'dev', project: 'b' }, ctx)
    expect(r.success).toBe(true)
    expect(probeContainer).toHaveBeenCalledTimes(1)
  })

  it('returns K8s basic status when runtime is kubernetes', async () => {
    vi.mocked(listEnvironments).mockResolvedValue([{ id: 1, name: 'dev', displayName: 'Dev', sortOrder: 0, createdAt: new Date() }])
    vi.mocked(getProductLineById).mockResolvedValue({ id: 1, name: 'pl', displayName: 'PL', description: '', createdAt: new Date(), updatedAt: new Date() })
    vi.mocked(listProductLineEnvs).mockResolvedValue([{
      id: 1, productLineId: 1, envId: 1, runtime: 'kubernetes', namespace: 'prod', enabled: true,
      connectionConfig: { serverIds: [10] }, defaultBranch: 'develop',
    }])
    vi.mocked(getTestServerById).mockResolvedValue({
      id: 10, productLineId: 1, name: 's1', role: 'app',
      host: '10.0.0.5', port: 22, username: 'root', credential: 'x',
      createdAt: new Date(),
    } as unknown as Awaited<ReturnType<typeof getTestServerById>>)
    vi.mocked(listProjects).mockResolvedValue([{
      id: 100, productLineId: 1, name: 'svc', displayName: 'SVC',
      gitlabPath: 'g/svc', harborProject: 'p/svc',
      ownerId: '', ownerName: '',
      dockerContainerName: '', k8sProjectName: 'svc-deploy', composePath: '',
      description: '', createdAt: new Date(), updatedAt: new Date(),
    }])
    vi.mocked(getConfig).mockResolvedValue({ key: 'harbor', value: { url: 'https://harbor.example.com' }, updatedAt: new Date() } as unknown as Awaited<ReturnType<typeof getConfig>>)
    vi.mocked(getRecentDeployments).mockResolvedValue([])
    vi.mocked(probeK8sDeployment).mockResolvedValue({ ready: 3, replicas: 3, image: 'harbor.example.com/p/svc:develop_a1b2c3d4' })

    const r = await checkEnvStatusTool.execute({ env: 'dev' }, ctx)
    expect(r.success).toBe(true)
    expect(r.output).toContain('SVC')
    expect(r.output).toContain('K8s') // footer mention
  })

  it('emits one row per server when probes diverge', async () => {
    vi.mocked(listEnvironments).mockResolvedValue([{ id: 1, name: 'dev', displayName: 'Dev', sortOrder: 0, createdAt: new Date() }])
    vi.mocked(getProductLineById).mockResolvedValue({ id: 1, name: 'pl', displayName: 'PL', description: '', createdAt: new Date(), updatedAt: new Date() })
    vi.mocked(listProductLineEnvs).mockResolvedValue([{
      id: 1, productLineId: 1, envId: 1, runtime: 'docker', namespace: '', enabled: true,
      connectionConfig: { serverIds: [10, 11] }, defaultBranch: 'develop',
    }])
    vi.mocked(getTestServerById).mockImplementation(async (id: number) => ({
      id, productLineId: 1, name: `s${id}`, role: 'app',
      host: `10.0.0.${id}`, port: 22, username: 'root', credential: 'x',
      createdAt: new Date(),
    } as unknown as Awaited<ReturnType<typeof getTestServerById>>))
    vi.mocked(listProjects).mockResolvedValue([{
      id: 100, productLineId: 1, name: 'svc', displayName: 'SVC',
      gitlabPath: 'g/svc', harborProject: 'p/svc',
      ownerId: '', ownerName: '',
      dockerContainerName: 'svc', k8sProjectName: '', composePath: '/opt/app',
      description: '', createdAt: new Date(), updatedAt: new Date(),
    }])
    vi.mocked(getConfig).mockResolvedValue({ key: 'harbor', value: { url: 'https://harbor.example.com' }, updatedAt: new Date() } as unknown as Awaited<ReturnType<typeof getConfig>>)
    vi.mocked(getRecentDeployments).mockResolvedValue([])
    // First probe: running on new image; second probe: exited — diverged state
    vi.mocked(probeContainer)
      .mockResolvedValueOnce({ container: { exists: true, state: 'running', health: 'healthy' }, deployed: { branch: 'develop', shortId: 'a1b2c3d4', imageTag: 'develop_a1b2c3d4' } })
      .mockResolvedValueOnce({ container: { exists: true, state: 'exited', exitCode: 137 }, deployed: { branch: 'develop', shortId: 'a1b2c3d4', imageTag: 'develop_a1b2c3d4' } })
    vi.mocked(getLatestBranchCommit).mockResolvedValue({ commitId: 'full', shortId: 'a1b2c3d4', message: 'fix' })
    vi.mocked(compareCommits).mockResolvedValue({ commitsBehind: 0, tooLarge: false, latestSummaries: [] })

    const r = await checkEnvStatusTool.execute({ env: 'dev' }, ctx)
    expect(r.success).toBe(true)
    expect(r.output).toContain('SVC @ 10.0.0.10')
    expect(r.output).toContain('SVC @ 10.0.0.11')
  })

  it('falls back to bare docker (direct docker inspect) when composePath is empty', async () => {
    vi.mocked(listEnvironments).mockResolvedValue([{ id: 1, name: 'dev', displayName: 'Dev', sortOrder: 0, createdAt: new Date() }])
    vi.mocked(getProductLineById).mockResolvedValue({ id: 1, name: 'pl', displayName: 'PL', description: '', createdAt: new Date(), updatedAt: new Date() })
    vi.mocked(listProductLineEnvs).mockResolvedValue([{
      id: 1, productLineId: 1, envId: 1, runtime: 'docker', namespace: '', enabled: true,
      connectionConfig: { serverIds: [10] }, defaultBranch: 'develop',
    }])
    vi.mocked(getTestServerById).mockResolvedValue({
      id: 10, productLineId: 1, name: 's1', role: 'app',
      host: '10.0.0.5', port: 22, username: 'root', credential: 'x',
      createdAt: new Date(),
    } as unknown as Awaited<ReturnType<typeof getTestServerById>>)
    vi.mocked(listProjects).mockResolvedValue([{
      id: 100, productLineId: 1, name: 'svc', displayName: 'SVC',
      gitlabPath: 'g/svc', harborProject: 'p/svc',
      ownerId: '', ownerName: '',
      dockerContainerName: 'svc', k8sProjectName: '', composePath: '',
      description: '', createdAt: new Date(), updatedAt: new Date(),
    }])
    vi.mocked(getConfig).mockResolvedValue({ key: 'harbor', value: { url: 'https://harbor.example.com' }, updatedAt: new Date() } as unknown as Awaited<ReturnType<typeof getConfig>>)
    vi.mocked(getRecentDeployments).mockResolvedValue([])
    vi.mocked(probeContainer).mockResolvedValue({
      container: { exists: true, state: 'running', startedAt: new Date().toISOString(), health: 'healthy', actualName: 'svc' },
      deployed: { branch: 'develop', shortId: 'a1b2c3d4', imageTag: 'develop_a1b2c3d4' },
    })
    vi.mocked(getLatestBranchCommit).mockResolvedValue({ commitId: 'full', shortId: 'a1b2c3d4', message: 'fix' })
    vi.mocked(compareCommits).mockResolvedValue({ commitsBehind: 0, tooLarge: false, latestSummaries: [] })

    const r = await checkEnvStatusTool.execute({ env: 'dev' }, ctx)
    expect(r.success).toBe(true)
    expect(probeContainer).toHaveBeenCalledWith(
      expect.objectContaining({ host: '10.0.0.5' }),
      undefined,
      'svc',
      'harbor.example.com',
      'p/svc',
    )
  })
})
