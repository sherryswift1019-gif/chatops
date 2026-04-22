import { describe, it, expect } from 'vitest'
import { linearizeStages } from '../../pipeline/graph-migration.js'
import type { StageDefinition } from '../../pipeline/types.js'

function makeStage(partial: Partial<StageDefinition> & Pick<StageDefinition, 'name' | 'stageType'>): StageDefinition {
  return {
    targetRoles: [], parallel: false, timeoutSeconds: 60,
    retryCount: 0, onFailure: 'stop', ...partial,
  }
}

describe('linearizeStages', () => {
  it('空数组返回空 graph', () => {
    const g = linearizeStages([])
    expect(g.nodes).toEqual([])
    expect(g.edges).toEqual([])
  })

  it('单 stage：一个 node、零 edge', () => {
    const g = linearizeStages([makeStage({ name: 'A', stageType: 'script', script: 'echo a' })])
    expect(g.nodes).toHaveLength(1)
    expect(g.nodes[0].name).toBe('A')
    expect(g.nodes[0].stageType).toBe('script')
    expect(g.nodes[0].id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)  // ULID
    expect(g.edges).toEqual([])
  })

  it('多 stage 串成线性链', () => {
    const g = linearizeStages([
      makeStage({ name: 'A', stageType: 'script' }),
      makeStage({ name: 'B', stageType: 'approval' }),
      makeStage({ name: 'C', stageType: 'script' }),
    ])
    expect(g.nodes).toHaveLength(3)
    expect(g.edges).toHaveLength(2)
    expect(g.edges[0].source).toBe(g.nodes[0].id)
    expect(g.edges[0].target).toBe(g.nodes[1].id)
    expect(g.edges[1].source).toBe(g.nodes[1].id)
    expect(g.edges[1].target).toBe(g.nodes[2].id)
    // 线性转换不产生条件边
    expect(g.edges[0].condition).toBeUndefined()
  })

  it('node.position 沿 y 递增', () => {
    const g = linearizeStages([
      makeStage({ name: 'A', stageType: 'script' }),
      makeStage({ name: 'B', stageType: 'script' }),
    ])
    expect(g.nodes[0].position.y).toBeLessThan(g.nodes[1].position.y)
  })

  it('保留 StageDefinition 所有字段', () => {
    const stage = makeStage({
      name: 'A', stageType: 'script', script: 'echo x',
      targetRoles: ['app'], parallel: true, timeoutSeconds: 120, retryCount: 2,
      onFailure: 'continue',
    })
    const g = linearizeStages([stage])
    expect(g.nodes[0]).toMatchObject({
      name: 'A', stageType: 'script', script: 'echo x',
      targetRoles: ['app'], parallel: true, timeoutSeconds: 120,
      retryCount: 2, onFailure: 'continue',
    })
  })
})
