import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../pipeline/artifact-resolver.js', () => ({
  listArtifacts: vi.fn(),
}))

import { listArtifacts } from '../../pipeline/artifact-resolver.js'
import { listArtifactsTool } from '../../agent/tools/list-artifacts.js'
import type { TaskContext } from '../../agent/tools/types.js'

const mockList = vi.mocked(listArtifacts)

const ctx: TaskContext = {
  taskId: 't1', groupId: 'g1', platform: 'dingtalk',
  initiatorId: 'u1', initiatorRole: 'developer',
}

beforeEach(() => mockList.mockReset())

describe('list_artifacts tool', () => {
  it('returns top-10 files in markdown numbered list', async () => {
    const files = Array.from({ length: 12 }, (_, i) => ({
      name: `F${i}.tar.gz`, path: `p/F${i}.tar.gz`, size: 100, mtime: 1000 - i,
      downloadUrl: `http://x/F${i}.tar.gz`,
    }))
    mockList.mockResolvedValue(files)
    const res = await listArtifactsTool.execute(
      { listUrl: 'http://x', glob: '*.tar.gz' },
      ctx,
    )
    expect(res.success).toBe(true)
    expect(res.output).toMatch(/1\..*F0\.tar\.gz/)
    expect(res.output).toMatch(/10\..*F9\.tar\.gz/)
    expect(res.output).not.toMatch(/11\./)
    expect(res.output).toMatch(/还有\s*2\s*个/)
    const data = res.data as { truncated: boolean }
    expect(data.truncated).toBe(true)
  })

  it('empty match returns friendly hint', async () => {
    mockList.mockResolvedValue([])
    const res = await listArtifactsTool.execute(
      { listUrl: 'http://x', glob: '*.foo' },
      ctx,
    )
    expect(res.success).toBe(true)
    expect(res.output).toContain('没有匹配')
  })

  it('rejects missing listUrl', async () => {
    const res = await listArtifactsTool.execute({ glob: '*' }, ctx)
    expect(res.success).toBe(false)
    expect(res.output).toContain('listUrl')
  })
})
