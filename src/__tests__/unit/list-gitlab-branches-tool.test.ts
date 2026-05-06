import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../db/repositories/projects-repo.js', () => ({
  listProjects: vi.fn(),
}))
vi.mock('../../config/gitlab.js', () => ({
  resolveGitlabConfig: vi.fn(),
}))
vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
  },
}))

import axios from 'axios'
import { listProjects } from '../../db/repositories/projects-repo.js'
import { resolveGitlabConfig } from '../../config/gitlab.js'
import {
  listGitlabBranchesTool,
  listProjectBranches,
} from '../../agent/tools/list-gitlab-branches.js'
import type { TaskContext } from '../../agent/tools/types.js'

const mockListProjects = vi.mocked(listProjects)
const mockResolveGitlabConfig = vi.mocked(resolveGitlabConfig)
const mockAxiosGet = vi.mocked(axios.get)

function ctx(): TaskContext {
  return {
    taskId: 't1', groupId: 'g1', platform: 'dingtalk',
    initiatorId: 'u1', initiatorRole: 'developer',
  } as TaskContext
}

function project(overrides: Partial<{ name: string; gitlabPath: string }> = {}) {
  return {
    id: 1, productLineId: 1,
    name: overrides.name ?? 'pas-api',
    displayName: 'PAS API',
    gitlabPath: overrides.gitlabPath ?? 'PAM/pas-api',
    harborProject: 'para-pam/pas-api',
    ownerId: 'u001', ownerName: '严益昌',
    dockerContainerName: '', k8sProjectName: '', composePath: '',
    description: '',
    createdAt: new Date(), updatedAt: new Date(),
  }
}

beforeEach(() => {
  mockListProjects.mockReset()
  mockResolveGitlabConfig.mockReset()
  mockAxiosGet.mockReset()
})

describe('list_gitlab_branches tool', () => {
  it('project 匹配失败 → 返回注册列表提示', async () => {
    mockListProjects.mockResolvedValue([
      project({ name: 'pas-api' }),
      project({ name: 'ssh-proxy' }),
    ])
    const res = await listGitlabBranchesTool.execute(
      { project: 'nonexistent' },
      ctx(),
    )
    expect(res.success).toBe(false)
    expect(res.output).toContain('nonexistent')
    expect(res.output).toContain('未找到匹配')
    expect(res.output).toContain('pas-api')
    expect(res.output).toContain('ssh-proxy')
    expect(mockAxiosGet).not.toHaveBeenCalled()
  })

  it('GitLab 未配置 → 友好空提示', async () => {
    mockListProjects.mockResolvedValue([project()])
    mockResolveGitlabConfig.mockResolvedValue({
      url: '', token: '', skipTlsVerify: false,
    })
    const res = await listGitlabBranchesTool.execute({ project: 'pas-api' }, ctx())
    expect(res.success).toBe(true)
    expect(res.output).toContain('没有查到分支')
    expect(mockAxiosGet).not.toHaveBeenCalled()
  })

  it('GitLab 正常返回分支 → 格式化输出', async () => {
    mockListProjects.mockResolvedValue([project()])
    mockResolveGitlabConfig.mockResolvedValue({
      url: 'http://code.paraview.cn',
      token: 'secret',
      skipTlsVerify: false,
    })
    mockAxiosGet.mockResolvedValue({
      data: [{ name: 'main' }, { name: 'dev' }, { name: 'release/1.0' }],
    })
    const res = await listGitlabBranchesTool.execute({ project: 'pas-api' }, ctx())
    expect(res.success).toBe(true)
    expect(res.output).toContain('- main')
    expect(res.output).toContain('- dev')
    expect(res.output).toContain('- release/1.0')
    expect(res.output).toContain('共 3 个')
    expect((res.data as { branches: string[] }).branches).toEqual(['main', 'dev', 'release/1.0'])

    // 验证调用参数正确（encodeURIComponent 了 gitlab path，header 带 token）
    expect(mockAxiosGet).toHaveBeenCalledTimes(1)
    const [url, cfg] = mockAxiosGet.mock.calls[0]
    expect(url).toContain('PAM%2Fpas-api')
    expect(url).toContain('/repository/branches')
    expect((cfg as { headers: Record<string, string> }).headers['PRIVATE-TOKEN']).toBe('secret')
  })

  it('GitLab 请求抛异常 → 空列表友好提示', async () => {
    mockListProjects.mockResolvedValue([project()])
    mockResolveGitlabConfig.mockResolvedValue({
      url: 'http://code.paraview.cn',
      token: 'secret',
      skipTlsVerify: false,
    })
    mockAxiosGet.mockRejectedValue(new Error('ECONNREFUSED'))
    const res = await listGitlabBranchesTool.execute({ project: 'pas-api' }, ctx())
    expect(res.success).toBe(true)
    expect(res.output).toContain('没有查到分支')
    expect((res.data as { branches: string[] }).branches).toEqual([])
  })
})

describe('listProjectBranches helper (deploy.ts 404 fallback 复用此函数)', () => {
  it('GitLab 未配置 → 返回空数组', async () => {
    mockResolveGitlabConfig.mockResolvedValue({
      url: '', token: '', skipTlsVerify: false,
    })
    const res = await listProjectBranches('PAM/pas-api')
    expect(res).toEqual([])
    expect(mockAxiosGet).not.toHaveBeenCalled()
  })

  it('GitLab 正常 → 返回分支名数组', async () => {
    mockResolveGitlabConfig.mockResolvedValue({
      url: 'http://code.paraview.cn',
      token: 'secret',
      skipTlsVerify: false,
    })
    mockAxiosGet.mockResolvedValue({
      data: [{ name: 'main' }, { name: 'dev' }],
    })
    const res = await listProjectBranches('PAM/pas-api')
    expect(res).toEqual(['main', 'dev'])
  })

  it('GitLab 请求异常 → 返回空数组（catch 吃掉，不抛）', async () => {
    mockResolveGitlabConfig.mockResolvedValue({
      url: 'http://code.paraview.cn',
      token: 'secret',
      skipTlsVerify: false,
    })
    mockAxiosGet.mockRejectedValue(new Error('network error'))
    const res = await listProjectBranches('PAM/pas-api')
    expect(res).toEqual([])
  })
})
