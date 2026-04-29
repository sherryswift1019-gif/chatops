/**
 * stage-running-marker — unit tests for markStageRunning + persistValues merge.
 *
 * 背景：build*Node 的 LangGraph callback 只在节点完成时返回一次 update。stage 跑
 * 期间 langgraph state 里没有该 stage 的 entry，admin Drawer 看不到 running
 * 状态。markStageRunning 在节点开头直写 DB；persistValues 改 merge 后，langgraph
 * state 不会把"跑中但 DB 已有的 running entry"覆盖丢失。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// 在 import markStageRunning 之前 mock test-runs repo，让单测不碰 DB。
const dbStore = new Map<number, Array<Record<string, unknown>>>()
const updateCalls: Array<{
  id: number
  currentStage: number
  stageResults: Array<Record<string, unknown>>
}> = []

vi.mock('../../db/repositories/test-runs.js', () => ({
  getTestRunById: vi.fn(async (id: number) => {
    if (!dbStore.has(id)) return null
    return {
      id,
      pipelineId: 1,
      triggerType: 'manual',
      triggeredBy: '',
      status: 'running',
      servers: {},
      currentStage: 0,
      stageResults: dbStore.get(id) ?? [],
      reportPath: '',
      startedAt: null,
      finishedAt: null,
      errorMessage: '',
      createdAt: new Date(),
      runtimeVars: {},
      triggerParams: {},
    }
  }),
  updateTestRunStage: vi.fn(
    async (id: number, currentStage: number, stageResults: Array<Record<string, unknown>>) => {
      // 深拷贝避免后续 push 修改 caller 数组污染 store。
      const copied = JSON.parse(JSON.stringify(stageResults))
      dbStore.set(id, copied)
      updateCalls.push({ id, currentStage, stageResults: copied })
    },
  ),
}))

import { markStageRunning, mergeAndPersistStageResults } from '../../pipeline/stage-status.js'

beforeEach(() => {
  dbStore.clear()
  updateCalls.length = 0
})

describe('markStageRunning', () => {
  it('写入 running entry 当 stage 不存在', async () => {
    dbStore.set(123, [])
    await markStageRunning(123, { name: '清理', stageType: 'script' }, '2026-04-29T00:00:00Z')

    const stored = dbStore.get(123)!
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({
      name: '清理',
      type: 'script',
      status: 'running',
      startedAt: '2026-04-29T00:00:00Z',
    })
  })

  it('不覆盖已 finalized 的 stage（success / failed / skipped）', async () => {
    const finalizedCases: Array<'success' | 'failed' | 'skipped'> = [
      'success',
      'failed',
      'skipped',
    ]
    for (const status of finalizedCases) {
      dbStore.clear()
      updateCalls.length = 0
      dbStore.set(7, [{ name: '清理', type: 'script', status, output: 'ok' }])
      await markStageRunning(7, { name: '清理', stageType: 'script' }, '2026-04-29T00:00:00Z')
      // helper 应是 no-op（DB 不变 + 不发 update 调用）
      expect(updateCalls).toHaveLength(0)
      expect(dbStore.get(7)).toEqual([
        { name: '清理', type: 'script', status, output: 'ok' },
      ])
    }
  })

  it('与既有其它 stage 共存，by-name merge 不影响 sibling', async () => {
    dbStore.set(1, [{ name: 'A', type: 'script', status: 'success' }])
    await markStageRunning(1, { name: 'B', stageType: 'capability' }, '2026-04-29T00:00:01Z')
    const stored = dbStore.get(1)!
    expect(stored).toHaveLength(2)
    expect(stored[0]).toMatchObject({ name: 'A', status: 'success' })
    expect(stored[1]).toMatchObject({
      name: 'B',
      type: 'capability',
      status: 'running',
      startedAt: '2026-04-29T00:00:01Z',
    })
  })

  it('既有 running entry 时 markStageRunning 重复调用是 no-op（不刷 startedAt）', async () => {
    dbStore.set(2, [{ name: 'X', type: 'script', status: 'running', startedAt: 'first' }])
    await markStageRunning(2, { name: 'X', stageType: 'script' }, 'second')
    // running 不算 finalized，但重复 mark 没意义；选择 no-op 保 startedAt 稳定。
    expect(updateCalls).toHaveLength(0)
    expect(dbStore.get(2)![0]).toMatchObject({ status: 'running', startedAt: 'first' })
  })

  it('run 不存在时静默（不 throw）', async () => {
    // dbStore 不放 999 → getTestRunById 返回 null
    await expect(
      markStageRunning(999, { name: 'X', stageType: 'script' }, 'now'),
    ).resolves.toBeUndefined()
    expect(updateCalls).toHaveLength(0)
  })

  it('支持 stageType 别名 type（防止字段名分歧）', async () => {
    dbStore.set(3, [])
    await markStageRunning(3, { name: 'Y', type: 'approval' }, 'now')
    expect(dbStore.get(3)![0]).toMatchObject({ type: 'approval', status: 'running' })
  })

  it('stageType / type 都缺时回落到 unknown', async () => {
    dbStore.set(4, [])
    await markStageRunning(4, { name: 'Z' } as { name: string }, 'now')
    expect(dbStore.get(4)![0]).toMatchObject({ type: 'unknown', status: 'running' })
  })
})

describe('mergeAndPersistStageResults (persistValues 替换路径)', () => {
  it('合并 langgraph state 后覆盖 running entry', async () => {
    dbStore.set(10, [
      { name: 'A', type: 'script', status: 'success' },
      { name: 'B', type: 'capability', status: 'running', startedAt: 't1' },
    ])
    // langgraph state 完成了 B
    await mergeAndPersistStageResults(10, 1, [
      { name: 'A', type: 'script', status: 'success' },
      { name: 'B', type: 'capability', status: 'success', startedAt: 't1', finishedAt: 't2' },
    ])
    const stored = dbStore.get(10)!
    expect(stored).toHaveLength(2)
    expect(stored[1]).toMatchObject({ name: 'B', status: 'success', finishedAt: 't2' })
  })

  it('保留 DB 中存在但 langgraph state 中缺失的 running entry', async () => {
    dbStore.set(20, [
      { name: 'A', type: 'script', status: 'success' },
      { name: 'C', type: 'capability', status: 'running', startedAt: 't0' },
    ])
    // langgraph state 没动 C（C 还在跑）
    await mergeAndPersistStageResults(20, 0, [
      { name: 'A', type: 'script', status: 'success' },
    ])
    const stored = dbStore.get(20)!
    expect(stored).toHaveLength(2)
    expect(stored.find((r) => r.name === 'C')).toMatchObject({
      status: 'running',
      startedAt: 't0',
    })
  })

  it('空 langgraph state 时不破坏 DB', async () => {
    dbStore.set(30, [{ name: 'A', type: 'script', status: 'running' }])
    await mergeAndPersistStageResults(30, 0, [])
    expect(dbStore.get(30)).toEqual([{ name: 'A', type: 'script', status: 'running' }])
  })
})
