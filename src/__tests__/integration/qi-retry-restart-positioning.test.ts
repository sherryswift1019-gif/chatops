import { describe, it, expect } from 'vitest'
import { MemorySaver, StateGraph } from '@langchain/langgraph'
import { PipelineStateAnnotation } from '../../pipeline/graph-state.js'

describe('LangGraph updateState + asNode positioning (Sub-plan E.2 验证)', () => {
  it('updateState(asNode=B) lets stream resume at C (B->C edge), re-running C', async () => {
    let cCallCount = 0
    let bCallCount = 0

    const graph = new StateGraph(PipelineStateAnnotation)
      .addNode('stage_0_a', async () => ({
        currentStageIndex: 0,
        stageResults: [{ name: 'A', type: 'a', status: 'success' as const }],
      }))
      .addNode('stage_1_b', async () => {
        bCallCount++
        return {
          currentStageIndex: 1,
          stageResults: [{ name: 'B', type: 'b', status: 'success' as const }],
        }
      })
      .addNode('stage_2_c', async () => {
        cCallCount++
        return {
          currentStageIndex: 2,
          stageResults: [{ name: 'C', type: 'c', status: 'success' as const }],
        }
      })
      .addEdge('__start__', 'stage_0_a')
      .addEdge('stage_0_a', 'stage_1_b')
      .addEdge('stage_1_b', 'stage_2_c')

    const compiled = graph.compile({ checkpointer: new MemorySaver() })
    const config = { configurable: { thread_id: 'test-1' } }

    // Initial run — all 3 nodes execute
    const result1 = await compiled.invoke({ runId: 1 }, config)
    expect(bCallCount).toBe(1)
    expect(cCallCount).toBe(1)
    expect(result1.stageResults.map((s: any) => s.name)).toEqual(['A', 'B', 'C'])

    // Snapshot should be at END (next=[])
    const snap1 = await compiled.getState(config)
    expect(snap1.next).toEqual([])

    // Now reposition: tell LangGraph "B just done, next is C"
    await compiled.updateState(config, {}, 'stage_1_b')

    // Snapshot should now point to C
    const snap2 = await compiled.getState(config)
    expect(snap2.next).toEqual(['stage_2_c'])

    // Stream — should only run C again
    await compiled.invoke(null, config)
    expect(bCallCount).toBe(1)  // B 没有再跑
    expect(cCallCount).toBe(2)  // C 跑了第二次！
  })
})
