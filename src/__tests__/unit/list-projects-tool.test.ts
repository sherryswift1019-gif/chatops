import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../db/repositories/projects-repo.js', () => ({
  listProjects: vi.fn(),
}))
vi.mock('../../db/repositories/product-lines.js', () => ({
  getProductLineById: vi.fn(),
}))

import { listProjects } from '../../db/repositories/projects-repo.js'
import { getProductLineById } from '../../db/repositories/product-lines.js'
import { listProductLineProjectsTool } from '../../agent/tools/list-projects.js'
import type { TaskContext } from '../../agent/tools/types.js'

const mockListProjects = vi.mocked(listProjects)
const mockGetProductLineById = vi.mocked(getProductLineById)

function ctx(productLineId: number | null): TaskContext {
  return {
    taskId: 't1', groupId: 'g1', platform: 'dingtalk',
    initiatorId: 'u1', initiatorRole: 'developer',
    productLineId: productLineId ?? undefined,
  } as TaskContext
}

beforeEach(() => {
  mockListProjects.mockReset()
  mockGetProductLineById.mockReset()
})

describe('list_product_line_projects tool', () => {
  it('returns friendly hint when user has no product line', async () => {
    const res = await listProductLineProjectsTool.execute({}, ctx(null))
    expect(res.success).toBe(true)
    expect(res.output).toContain('还没绑定产线')
    expect(mockListProjects).not.toHaveBeenCalled()
  })

  it('returns "no modules" message when product line has no projects', async () => {
    mockGetProductLineById.mockResolvedValue(
      { id: 1, name: 'PAM', displayName: 'PAM平台', description: '', createdAt: new Date(), updatedAt: new Date() },
    )
    mockListProjects.mockResolvedValue([])
    const res = await listProductLineProjectsTool.execute({}, ctx(1))
    expect(res.success).toBe(true)
    expect(res.output).toContain('PAM平台')
    expect(res.output).toContain('还没有配置模块')
  })

  it('renders markdown list when projects exist', async () => {
    mockGetProductLineById.mockResolvedValue(
      { id: 1, name: 'PAM', displayName: 'PAM平台', description: '', createdAt: new Date(), updatedAt: new Date() },
    )
    mockListProjects.mockResolvedValue([
      {
        id: 1, productLineId: 1, name: 'ssh-proxy', displayName: 'SSH 代理',
        gitlabPath: 'PAM/c-code/ssh-proxy', harborProject: 'para-pam/ssh-proxy',
        ownerId: 'u001', ownerName: '严益昌',
        dockerContainerName: '', k8sProjectName: '', composePath: '',
        description: 'ssh 代理服务',
        createdAt: new Date(), updatedAt: new Date(),
      },
      {
        id: 2, productLineId: 1, name: 'rdp-proxy', displayName: 'RDP 代理',
        gitlabPath: 'PAM/c-code/rdp-proxy', harborProject: 'para-pam/rdp-proxy',
        ownerId: 'u002', ownerName: '张三',
        dockerContainerName: '', k8sProjectName: '', composePath: '',
        description: '',
        createdAt: new Date(), updatedAt: new Date(),
      },
    ])
    const res = await listProductLineProjectsTool.execute({}, ctx(1))
    expect(res.success).toBe(true)
    expect(res.output).toContain('PAM平台 · 2 个模块')
    expect(res.output).toContain('**SSH 代理** (`ssh-proxy`)')
    expect(res.output).toContain('👤 严益昌')
    expect(res.output).toContain('GitLab: `PAM/c-code/ssh-proxy`')
    expect(res.output).toContain('Harbor: `para-pam/ssh-proxy`')
    expect(res.output).toContain('**RDP 代理** (`rdp-proxy`)')
    expect(res.output).toContain('👤 张三')
  })

  it('shows placeholder when owner_name is empty', async () => {
    mockGetProductLineById.mockResolvedValue(
      { id: 1, name: 'PAM', displayName: 'PAM平台', description: '', createdAt: new Date(), updatedAt: new Date() },
    )
    mockListProjects.mockResolvedValue([
      {
        id: 1, productLineId: 1, name: 'orphan', displayName: '孤儿模块',
        gitlabPath: 'PAM/orphan', harborProject: 'para-pam/orphan',
        ownerId: '', ownerName: '',
        dockerContainerName: '', k8sProjectName: '', composePath: '',
        description: '',
        createdAt: new Date(), updatedAt: new Date(),
      },
    ])
    const res = await listProductLineProjectsTool.execute({}, ctx(1))
    expect(res.output).toContain('👤 未指定负责人')
  })

  it('omits GitLab/Harbor fields when empty', async () => {
    mockGetProductLineById.mockResolvedValue(
      { id: 1, name: 'PAM', displayName: 'PAM平台', description: '', createdAt: new Date(), updatedAt: new Date() },
    )
    mockListProjects.mockResolvedValue([
      {
        id: 1, productLineId: 1, name: 'legacy', displayName: '遗留模块',
        gitlabPath: '', harborProject: '',
        ownerId: 'u001', ownerName: '老王',
        dockerContainerName: '', k8sProjectName: '', composePath: '',
        description: '',
        createdAt: new Date(), updatedAt: new Date(),
      },
    ])
    const res = await listProductLineProjectsTool.execute({}, ctx(1))
    expect(res.output).toContain('👤 老王')
    expect(res.output).not.toContain('GitLab:')
    expect(res.output).not.toContain('Harbor:')
  })
})
