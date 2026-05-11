import { describe, it, expect, beforeAll } from 'vitest'
import { resetTestDb } from '../helpers/db.js'
import { bootstrapQuickImpl } from '../../quick-impl/bootstrap.js'
import { getTestPipelineByName } from '../../db/repositories/test-pipelines.js'
import type { PipelineGraph } from '../../pipeline/types.js'

describe('Quick-Impl bootstrap v13 (cleanup 加 remote_branch + draft_mr)', () => {
  beforeAll(async () => {
    await resetTestDb()
  })

  it('cleanup node targets include remote_branch + draft_mr', async () => {
    await bootstrapQuickImpl()
    const pipeline = await getTestPipelineByName('quick-impl')
    expect(pipeline).toBeDefined()

    const graph = pipeline!.graph as PipelineGraph
    const cleanupNode = graph.nodes.find(n => n.id === 'cleanup')
    expect(cleanupNode).toBeDefined()

    const targets = ((cleanupNode as any).params?.targets ?? []) as Array<{ kind: string }>
    const kinds = targets.map(t => t.kind)

    expect(kinds).toContain('worktree')
    expect(kinds).toContain('bare_repo')
    expect(kinds).toContain('remote_branch')   // 新增
    expect(kinds).toContain('draft_mr')        // 新增
  })
})
