import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../db/repositories/test-pipelines.js', () => ({
  getTestPipelineById: vi.fn(),
}))

import { getTestPipelineById } from '../../db/repositories/test-pipelines.js'
import { getPipelineArtifactInputsTool } from '../../agent/tools/get-pipeline-artifact-inputs.js'
import type { TaskContext } from '../../agent/tools/types.js'

const mockGet = vi.mocked(getTestPipelineById)
const ctx: TaskContext = {
  taskId: 't1', groupId: 'g1', platform: 'dingtalk',
  initiatorId: 'u1', initiatorRole: 'developer',
}

beforeEach(() => mockGet.mockReset())

function pipeline(artifactInputs: unknown[]): any {
  return {
    id: 1, name: 'P', productLineId: 1, description: '', stages: [],
    serverRoles: {}, schedule: '', enabled: true, triggerParams: {},
    variables: {}, artifactInputs,
    createdAt: new Date(), updatedAt: new Date(),
  }
}

describe('get_pipeline_artifact_inputs tool', () => {
  it('returns empty array when pipeline has none', async () => {
    mockGet.mockResolvedValue(pipeline([]))
    const res = await getPipelineArtifactInputsTool.execute({ pipelineId: 1 }, ctx)
    expect(res.success).toBe(true)
    expect(res.data).toEqual({ inputs: [] })
    expect(res.output).toContain('无需')
  })

  it('returns inputs with user-readable markdown', async () => {
    mockGet.mockResolvedValue(pipeline([
      { name: '选 PAM 包', listUrl: 'http://x', glob: 'PAM-*.tar.gz', outputVar: 'PACKAGE_URL', valueFrom: 'url' },
    ]))
    const res = await getPipelineArtifactInputsTool.execute({ pipelineId: 1 }, ctx)
    expect(res.success).toBe(true)
    expect(res.output).toContain('选 PAM 包')
    expect(res.output).toContain('PAM-*.tar.gz')
    const data = res.data as { inputs: unknown[] }
    expect(data.inputs).toHaveLength(1)
  })

  it('returns error when pipeline missing', async () => {
    mockGet.mockResolvedValue(null)
    const res = await getPipelineArtifactInputsTool.execute({ pipelineId: 999 }, ctx)
    expect(res.success).toBe(false)
    expect(res.output).toContain('999')
  })

  it('rejects missing pipelineId', async () => {
    const res = await getPipelineArtifactInputsTool.execute({}, ctx)
    expect(res.success).toBe(false)
    expect(res.output).toContain('pipelineId')
  })
})
